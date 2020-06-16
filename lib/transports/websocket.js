const Transport = require("../transport");
const parser = require("engine.io-parser");
const debug = require("debug")("engine:ws");

// 基于ws模块的封装
class WebSocket extends Transport {
  /**
   * WebSocket transport
   *
   * @param {http.IncomingMessage}
   * @api public
   */
  constructor(req) {
    super(req);
    // 保存ws模块的websocket对象
    this.socket = req.websocket;
    // 注册事件，由ws模块触发，然后再往上层触发
    this.socket.on("message", this.onData.bind(this));
    this.socket.once("close", this.onClose.bind(this));
    this.socket.on("error", this.onError.bind(this));
    this.socket.on("headers", headers => {
      this.emit("headers", headers);
    });
    this.writable = true;
    this.perMessageDeflate = null;
  }

  /**
   * Transport name
   *
   * @api public
   */
  get name() {
    return "websocket";
  }

  /**
   * Advertise upgrade support.
   *
   * @api public
   */
  get handlesUpgrades() {
    return true;
  }

  /**
   * Advertise framing support.
   *
   * @api public
   */
  get supportsFraming() {
    return true;
  }

  /**
   * Processes the incoming data.
   *
   * @param {String} encoded packet
   * @api private
   */
  onData(data) {
    debug('received "%s"', data);
    super.onData(data);
  }

  /**
   * Writes a packet payload.
   *
   * @param {Array} packets
   * @api private
   */
  send(packets) {
    var self = this;
    // 对数据编码，然后调用ws模块的send方法发送，他会再次编码（按照websocket协议）
    for (var i = 0; i < packets.length; i++) {
      var packet = packets[i];
      parser.encodePacket(packet, self.supportsBinary, send);
    }

    function send(data) {
      debug('writing "%s"', data);

      // always creates a new object since ws modifies it
      var opts = {};
      if (packet.options) {
        opts.compress = packet.options.compress;
      }

      if (self.perMessageDeflate) {
        var len =
          "string" === typeof data ? Buffer.byteLength(data) : data.length;
        if (len < self.perMessageDeflate.threshold) {
          opts.compress = false;
        }
      }

      self.writable = false;
      self.socket.send(data, opts, onEnd);
    }
    // 发生成功后触发drain事件，告诉上层可以继续发送了
    function onEnd(err) {
      if (err) return self.onError("write error", err.stack);
      self.writable = true;
      self.emit("drain");
    }
  }

  /**
   * Closes the transport.
   *
   * @api private
   */
  // 关闭websocket
  doClose(fn) {
    debug("closing");
    this.socket.close();
    fn && fn();
  }
}

module.exports = WebSocket;
