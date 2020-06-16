const EventEmitter = require("events");
const debug = require("debug")("engine:socket");

class Socket extends EventEmitter {
  /**
   * Client class (abstract).
   *
   * @api private
   */
  constructor(id, server, transport, req) {
    super();
    this.id = id;
    // socket关联的服务器
    this.server = server;
    // 是否正在切换协议
    this.upgrading = false;
    // 是否已经完成协议切换
    this.upgraded = false;
    // 状态
    this.readyState = "opening";
    // 待写数据
    this.writeBuffer = [];
    this.packetsFn = [];
    this.sentCallbackFn = [];
    // 关闭数据通道时执行的清除函数集
    this.cleanupFn = [];
    // 对应的request，支持长轮询
    this.request = req;

    // Cache IP since it might not be in the req later
    if (req.websocket && req.websocket._socket) {
      this.remoteAddress = req.websocket._socket.remoteAddress;
    } else {
      this.remoteAddress = req.connection.remoteAddress;
    }

    this.checkIntervalTimer = null;
    // 检测是否完成协议切换的定时器id
    this.upgradeTimeoutTimer = null;

    this.pingTimeoutTimer = null;
    // 发送ping包后，多久没有收到回复则断开连接对应的定时器id
    this.pingIntervalTimer = null;
    // 设置通信通道
    this.setTransport(transport);
    this.onOpen();
  }

  /**
   * Called upon transport considered open.
   *
   * @api private
   */
  // 发送由long polling升级到websocket的通知包 或者是直接建立websocket通信时发生的包
  onOpen() {
    this.readyState = "open";

    // sends an `open` packet
    this.transport.sid = this.id;
    this.sendPacket(
      "open",
      JSON.stringify({
        sid: this.id,
        // 可以升级到这个（些）协议
        upgrades: this.getAvailableUpgrades(),
        // 心跳间隔
        pingInterval: this.server.opts.pingInterval,
        // 多久后发送心跳
        pingTimeout: this.server.opts.pingTimeout
      })
    );

    if (this.server.opts.initialPacket) {
      this.sendPacket("message", this.server.opts.initialPacket);
    }
    // 触发open事件
    this.emit("open");
    // 开启心跳检测
    this.schedulePing();
  }

  /**
   * Called upon transport packet.
   *
   * @param {Object} packet
   * @api private
   */
  onPacket(packet) {
    if ("open" === this.readyState) {
      // export packet event
      debug("packet");
      this.emit("packet", packet);

      // Reset ping timeout on any packet, incoming data is a good sign of
      // other side's liveness
      // 收到数据包后重置定时器，避免关闭连接
      this.resetPingTimeout(
        this.server.opts.pingInterval + this.server.opts.pingTimeout
      );

      switch (packet.type) {
        // 收到pong之后，等待一段时间后，继续发送ping包
        case "pong":
          debug("got pong");
          this.schedulePing();
          this.emit("heartbeat");
          break;
        // 出错，关闭socket
        case "error":
          
          this.onClose("parse error");
          break;

        case "message":
          this.emit("data", packet.data);
          this.emit("message", packet.data);
          break;
      }
    } else {
      debug("packet received with closed socket");
    }
  }

  /**
   * Called upon transport error.
   *
   * @param {Error} error object
   * @api private
   */
  // 通道出错时关闭socket
  onError(err) {
    debug("transport error");
    this.onClose("transport error", err);
  }

  /**
   * Pings client every `this.pingInterval` and expects response
   * within `this.pingTimeout` or closes connection.
   *
   * @api private
   */
  // pingInterval时间内没有回包（即没有清除定时器）则发送心跳包，并开启另一个定时器，如果心跳包也没有回复，pingTimeout时间内关闭连接
  schedulePing() {
    clearTimeout(this.pingIntervalTimer);
    this.pingIntervalTimer = setTimeout(() => {
      debug(
        "writing ping packet - expecting pong within %sms",
        this.server.opts.pingTimeout
      );
      this.sendPacket("ping");
      this.resetPingTimeout(this.server.opts.pingTimeout);
    }, this.server.opts.pingInterval);
  }

  /**
   * Resets ping timeout.
   *
   * @api private
   */
  resetPingTimeout(timeout) {
    clearTimeout(this.pingTimeoutTimer);
    this.pingTimeoutTimer = setTimeout(() => {
      if (this.readyState === "closed") return;
      this.onClose("ping timeout");
    }, timeout);
  }

  /**
   * Attaches handlers for the given transport.
   *
   * @param {Transport} transport
   * @api private
   */
  // 设置socket对应的数据通道
  setTransport(transport) {
    const onError = this.onError.bind(this);
    const onPacket = this.onPacket.bind(this);
    const flush = this.flush.bind(this);
    const onClose = this.onClose.bind(this, "transport close");
    // 通道有数据则通知socket等，socket再往上报
    this.transport = transport;
    this.transport.once("error", onError);
    this.transport.on("packet", onPacket);
    this.transport.on("drain", flush);
    this.transport.once("close", onClose);
    // this function will manage packet events (also message callbacks)
    this.setupSendCallback();
    // 关闭数据通道时执行的清除函数
    this.cleanupFn.push(function() {
      transport.removeListener("error", onError);
      transport.removeListener("packet", onPacket);
      transport.removeListener("drain", flush);
      transport.removeListener("close", onClose);
    });
  }

  /**
   * Upgrades socket to the given transport
   *
   * @param {Transport} transport
   * @api private
   */
  // 切换底层的数据通道，可能切换失败
  maybeUpgrade(transport) {
    debug(
      'might upgrade socket transport from "%s" to "%s"',
      this.transport.name,
      transport.name
    );
    // 正在切换
    this.upgrading = true;

    const self = this;

    // set transport upgrade timer 超时还没有切换成功则关闭
    self.upgradeTimeoutTimer = setTimeout(function() {
      debug("client did not complete upgrade - closing transport");
      cleanup();
      if ("open" === transport.readyState) {
        transport.close();
      }
    }, this.server.opts.upgradeTimeout);

    function onPacket(packet) {
      // 客户端使用websocket协议发送一个ping探测包，服务器回复一个pong说明建立了websocket通道
      if ("ping" === packet.type && "probe" === packet.data) {
        transport.send([{ type: "pong", data: "probe" }]);
        self.emit("upgrading", transport);
        clearInterval(self.checkIntervalTimer);
        self.checkIntervalTimer = setInterval(check, 100);
      } else if ("upgrade" === packet.type && self.readyState !== "closed") {
        // 客户端发送upgrade包，完成long polling到websocket协议的升级
        debug("got upgrade packet - upgrading");
        cleanup();
        self.transport.discard();
        self.upgraded = true;
        // 关闭旧的通道
        self.clearTransport();
        // 设置新的通道
        self.setTransport(transport);
        // 触发协议更换事件
        self.emit("upgrade", transport);
        // 开启心跳探测
        self.schedulePing();
        // 发送之前缓存的数据包
        self.flush();
        // 升级期间关闭了，则关闭通道
        if (self.readyState === "closing") {
          transport.close(function() {
            self.onClose("forced close");
          });
        }
      } else {
        // 无效的包，则关闭通道，即切换协议失败
        cleanup();
        transport.close();
      }
    }

    // we force a polling cycle to ensure a fast upgrade
    function check() {
      if ("polling" === self.transport.name && self.transport.writable) {
        debug("writing a noop packet to polling for fast upgrade");
        self.transport.send([{ type: "noop" }]);
      }
    }
    // 切换协议失败，恢复
    function cleanup() {
      self.upgrading = false;

      clearInterval(self.checkIntervalTimer);
      self.checkIntervalTimer = null;

      clearTimeout(self.upgradeTimeoutTimer);
      self.upgradeTimeoutTimer = null;

      transport.removeListener("packet", onPacket);
      transport.removeListener("close", onTransportClose);
      transport.removeListener("error", onError);
      self.removeListener("close", onClose);
    }
    // 切换协议失败，关闭
    function onError(err) {
      debug("client did not complete upgrade - %s", err);
      cleanup();
      transport.close();
      transport = null;
    }
    // 通道被关闭
    function onTransportClose() {
      onError("transport closed");
    }
    // 还没切换成功，连接就被关闭，则关闭通道
    function onClose() {
      onError("socket closed");
    }

    transport.on("packet", onPacket);
    transport.once("close", onTransportClose);
    transport.once("error", onError);

    self.once("close", onClose);
  }

  /**
   * Clears listeners and timers associated with current transport.
   *
   * @api private
   */
  // 废弃该通道时，关闭通道以及清除注册的事件
  clearTransport() {
    let cleanup;

    const toCleanUp = this.cleanupFn.length;
    // 执行清除函数
    for (let i = 0; i < toCleanUp; i++) {
      cleanup = this.cleanupFn.shift();
      cleanup();
    }

    // silence further transport errors and prevent uncaught exceptions
    this.transport.on("error", function() {
      debug("error triggered by discarded transport");
    });

    // ensure transport won't stay open
    this.transport.close();

    clearTimeout(this.pingTimeoutTimer);
  }

  /**
   * Called upon transport considered closed.
   * Possible reasons: `ping timeout`, `client error`, `parse error`,
   * `transport error`, `server close`, `transport close`
   */
  // 底层的数据通道关闭后或者建立数据通道失败时执行的回调
  onClose(reason, description) {
    if ("closed" !== this.readyState) {
      this.readyState = "closed";

      // clear timers
      clearTimeout(this.pingIntervalTimer);
      clearTimeout(this.pingTimeoutTimer);

      clearInterval(this.checkIntervalTimer);
      this.checkIntervalTimer = null;
      clearTimeout(this.upgradeTimeoutTimer);
      const self = this;
      // clean writeBuffer in next tick, so developers can still
      // grab the writeBuffer on 'close' event
      process.nextTick(function() {
        self.writeBuffer = [];
      });
      this.packetsFn = [];
      this.sentCallbackFn = [];
      this.clearTransport();
      // 触发close事件给上层
      this.emit("close", reason, description);
    }
  }

  /**
   * Setup and manage send callback
   *
   * @api private
   */
  
  setupSendCallback() {
    const self = this;
    // 监听drain事件，底层通道在发送数据成功后会触发drain事件，然后执行回调
    this.transport.on("drain", onDrain);
    // 关闭数据通道时执行的清除函数
    this.cleanupFn.push(function() {
      self.transport.removeListener("drain", onDrain);
    });

    // the message was sent successfully, execute the callback
    function onDrain() {
      if (self.sentCallbackFn.length > 0) {
        const seqFn = self.sentCallbackFn.splice(0, 1)[0];
        if ("function" === typeof seqFn) {
          debug("executing send callback");
          seqFn(self.transport);
        } else if (Array.isArray(seqFn)) {
          debug("executing batch send callback");
          const l = seqFn.length;
          let i = 0;
          for (; i < l; i++) {
            if ("function" === typeof seqFn[i]) {
              seqFn[i](self.transport);
            }
          }
        }
      }
    }
  }

  /**
   * Sends a message packet.
   *
   * @param {String} message
   * @param {Object} options
   * @param {Function} callback
   * @return {Socket} for chaining
   * @api public
   */
  // 发送数据包
  send(data, options, callback) {
    this.sendPacket("message", data, options, callback);
    return this;
  }

  write(data, options, callback) {
    this.sendPacket("message", data, options, callback);
    return this;
  }

  /**
   * Sends a packet.
   *
   * @param {String} packet type
   * @param {String} optional, data
   * @param {Object} options
   * @api private
   */
  // 发送一个数据包
  sendPacket(type, data, options, callback) {
    if ("function" === typeof options) {
      callback = options;
      options = null;
    }

    options = options || {};
    options.compress = false !== options.compress;

    if ("closing" !== this.readyState && "closed" !== this.readyState) {
      debug('sending packet "%s" (%s)', type, data);

      const packet = {
        type: type,
        options: options
      };
      if (data) packet.data = data;

      // exports packetCreate event
      this.emit("packetCreate", packet);
      // 缓存起来
      this.writeBuffer.push(packet);

      // add send callback to object, if defined
      // 保存发送成功后执行的回调
      if (callback) this.packetsFn.push(callback);
      // 发送
      this.flush();
    }
  }

  /**
   * Attempts to flush the packets buffer.
   *
   * @api private
   */
  flush() {
    if (
      "closed" !== this.readyState &&
      this.transport.writable &&
      this.writeBuffer.length
    ) {
      debug("flushing buffer to transport");
      this.emit("flush", this.writeBuffer);
      this.server.emit("flush", this, this.writeBuffer);
      const wbuf = this.writeBuffer;
      this.writeBuffer = [];
      // 变成发送成功后执行的回调
      if (!this.transport.supportsFraming) {
        this.sentCallbackFn.push(this.packetsFn);
      } else {
        this.sentCallbackFn.push.apply(this.sentCallbackFn, this.packetsFn);
      }
      this.packetsFn = [];
      // 使用数据通道进行发送
      this.transport.send(wbuf);
      // 发完触发drain事件，可以继续发送
      this.emit("drain");
      this.server.emit("drain", this);
    }
  }

  /**
   * Get available upgrades for this socket.
   *
   * @api private
   */
  // 获取支持的协议
  getAvailableUpgrades() {
    const availableUpgrades = [];
    const allUpgrades = this.server.upgrades(this.transport.name);
    let i = 0;
    const l = allUpgrades.length;
    for (; i < l; ++i) {
      const upg = allUpgrades[i];
      if (this.server.opts.transports.indexOf(upg) !== -1) {
        availableUpgrades.push(upg);
      }
    }
    return availableUpgrades;
  }

  /**
   * Closes the socket and underlying transport.
   *
   * @param {Boolean} optional, discard
   * @return {Socket} for chaining
   * @api public
   */
  // 关闭数据通道
  close(discard) {
    if ("open" !== this.readyState) return;
    // 正在关闭
    this.readyState = "closing";
    // 还有数据，则触发drain事件，等待可发送并且发送完后再关闭通道，否则直接关闭
    if (this.writeBuffer.length) {
      this.once("drain", this.closeTransport.bind(this, discard));
      return;
    }

    this.closeTransport(discard);
  }

  /**
   * Closes the underlying transport.
   *
   * @param {Boolean} discard
   * @api private
   */
  // 关闭数据通道
  closeTransport(discard) {
    if (discard) this.transport.discard();
    this.transport.close(this.onClose.bind(this, "forced close"));
  }
}

module.exports = Socket;
