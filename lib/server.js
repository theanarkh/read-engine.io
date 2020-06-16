const qs = require("querystring");
const parse = require("url").parse;
const base64id = require("base64id");
const transports = require("./transports");
const EventEmitter = require("events").EventEmitter;
const Socket = require("./socket");
const debug = require("debug")("engine");
const cookieMod = require("cookie");

class Server extends EventEmitter {
  /**
   * Server constructor.
   *
   * @param {Object} options
   * @api public
   */
  constructor(opts = {}) {
    super();
    
    this.clients = {};
    this.clientsCount = 0;

    this.opts = Object.assign(
      {
        wsEngine: process.env.EIO_WS_ENGINE || "ws",
        pingTimeout: 5000,
        pingInterval: 25000,
        upgradeTimeout: 10000,
        maxHttpBufferSize: 1e6,
        transports: Object.keys(transports),
        allowUpgrades: true,
        perMessageDeflate: {
          threshold: 1024
        },
        httpCompression: {
          threshold: 1024
        },
        cors: false
      },
      opts
    );

    if (opts.cookie) {
      this.opts.cookie = Object.assign(
        {
          name: "io",
          path: "/",
          httpOnly: opts.cookie.path !== false,
          sameSite: "lax"
        },
        opts.cookie
      );
    }

    if (this.opts.cors) {
      this.corsMiddleware = require("cors")(this.opts.cors);
    }

    this.init();
  }

  /**
   * Initialize websocket server
   *
   * @api private
   */
  // 初始化websocket服务器
  init() {
    if (!~this.opts.transports.indexOf("websocket")) return;

    if (this.ws) this.ws.close();

    // add explicit require for bundlers like webpack
    const wsModule =
      this.opts.wsEngine === "ws" ? require("ws") : require(this.opts.wsEngine);
    this.ws = new wsModule.Server({
      // 不使用websocket的服务器能力
      noServer: true,
      clientTracking: false,
      perMessageDeflate: this.opts.perMessageDeflate,
      maxPayload: this.opts.maxHttpBufferSize
    });
  }

  /**
   * Returns a list of available transports for upgrade given a certain transport.
   *
   * @return {Array}
   * @api public
   */
  // 根据当前的数据通道，是否可以切换到另一个（多个）数据通道
  upgrades(transport) {
    // 不允许切换
    if (!this.opts.allowUpgrades) return [];
    return transports[transport].upgradesTo || [];
  }

  /**
   * Verifies a request.
   *
   * @param {http.IncomingMessage}
   * @return {Boolean} whether the request is valid
   * @api private
   */
  // 校验每个请求的合法性
  verify(req, upgrade, fn) {
    // transport check
    const transport = req._query.transport;
    // 不合法通道
    if (!~this.opts.transports.indexOf(transport)) {
      debug('unknown transport "%s"', transport);
      return fn(Server.errors.UNKNOWN_TRANSPORT, false);
    }

    // 'Origin' header check
    const isOriginInvalid = checkInvalidHeaderChar(req.headers.origin);
    if (isOriginInvalid) {
      req.headers.origin = null;
      debug("origin header invalid");
      return fn(Server.errors.BAD_REQUEST, false);
    }

    // sid check
    const sid = req._query.sid;
    if (sid) {
      // 非法的sid
      if (!this.clients.hasOwnProperty(sid)) {
        debug('unknown sid "%s"', sid);
        return fn(Server.errors.UNKNOWN_SID, false);
      }
      // sid对应的管道名称和客户端传过来的不一样，并且不是切换协议（upgrade为false）的请求
      if (!upgrade && this.clients[sid].transport.name !== transport) {
        debug("bad request: unexpected transport without upgrade");
        return fn(Server.errors.BAD_REQUEST, false);
      }
    } else {
      // handshake is GET only 升级协议只能是GET请求
      if ("GET" !== req.method)
        return fn(Server.errors.BAD_HANDSHAKE_METHOD, false);
      if (!this.opts.allowRequest) return fn(null, true);
      // 自定义判断
      return this.opts.allowRequest(req, fn);
    }

    fn(null, true);
  }

  /**
   * Prepares a request by processing the query string.
   *
   * @api private
   */
  // 解析query参数挂载到req._query
  prepare(req) {
    // try to leverage pre-existing `req._query` (e.g: from connect)
    if (!req._query) {
      req._query = ~req.url.indexOf("?") ? qs.parse(parse(req.url).query) : {};
    }
  }

  /**
   * Closes all clients.
   *
   * @api public
   */
  // 关闭websocket服务
  close() {
    debug("closing all open clients");
    // 关闭所有已连接的socket
    for (let i in this.clients) {
      if (this.clients.hasOwnProperty(i)) {
        this.clients[i].close(true);
      }
    }
    // 关闭websocket通道，如果使用了的话
    if (this.ws) {
      debug("closing webSocketServer");
      this.ws.close();
      // don't delete this.ws because it can be used again if the http server starts listening again
    }
    return this;
  }

  /**
   * Handles an Engine.IO HTTP request.
   *
   * @param {http.IncomingMessage} request
   * @param {http.ServerResponse|http.OutgoingMessage} response
   * @api public
   */
  // 处理http请求
  handleRequest(req, res) {
    debug('handling "%s" http request "%s"', req.method, req.url);
    this.prepare(req);
    req.res = res;

    const callback = (err, success) => {
      if (!success) {
        sendErrorMessage(req, res, err);
        return;
      }
      // 有sid说明已经建立了数据通道，则处理数据，否则握手
      if (req._query.sid) {
        debug("setting new request for existing client");
        this.clients[req._query.sid].transport.onRequest(req);
      } else {
        this.handshake(req._query.transport, req);
      }
    };

    if (this.corsMiddleware) {
      this.corsMiddleware.call(null, req, res, () => {
        this.verify(req, false, callback);
      });
    } else {
      this.verify(req, false, callback);
    }
  }

  /**
   * generate a socket id.
   * Overwrite this method to generate your custom socket id
   *
   * @param {Object} request object
   * @api public
   */
  generateId(req) {
    return base64id.generateId();
  }

  /**
   * Handshakes a new client.
   *
   * @param {String} transport name
   * @param {Object} request object
   * @api private
   */
  /*
   1. 通过客户端传过来的通道名称，开始握手，服务器给客户端回复一个包(如下)，然后客户端使用websocket协议再次发生升级协议的请求
    {
      "type": "open",
      "data": {
        "sid": "36Yib8-rSutGQYLfAAAD",  // the unique session id
        "upgrades": ["websocket"],      // the list of possible transport upgrades
        "pingInterval": 25000,          // the 1st parameter for the heartbeat mechanism
        "pingTimeout": 5000             // the 2nd parameter for the heartbeat mechanism
      }
    }

    2 直接是建立websocket协议通道
  */
  async handshake(transportName, req) {
    let id;
    try {
      id = await this.generateId(req);
    } catch (e) {
      debug("error while generating an id");
      sendErrorMessage(req, req.res, Server.errors.BAD_REQUEST);
      return;
    }

    debug('handshaking client "%s"', id);

    try {
      // 新建一个通道
      var transport = new transports[transportName](req);
      if ("polling" === transportName) {
        transport.maxHttpBufferSize = this.opts.maxHttpBufferSize;
        transport.httpCompression = this.opts.httpCompression;
      } else if ("websocket" === transportName) {
        transport.perMessageDeflate = this.opts.perMessageDeflate;
      }

      if (req._query && req._query.b64) {
        transport.supportsBinary = false;
      } else {
        transport.supportsBinary = true;
      }
    } catch (e) {
      debug('error handshaking to transport "%s"', transportName);
      sendErrorMessage(req, req.res, Server.errors.BAD_REQUEST);
      return;
    }
    // 新建一个socket，把上下文传入socket中。socket会发送建立从long polling到websocket的回复包
    const socket = new Socket(id, this, transport, req);
    const self = this;

    if (this.opts.cookie) {
      transport.on("headers", headers => {
        headers["Set-Cookie"] = cookieMod.serialize(
          this.opts.cookie.name,
          id,
          this.opts.cookie
        );
      });
    }

    transport.onRequest(req);
    // 该server下建立的连接数
    this.clients[id] = socket;
    this.clientsCount++;
    // 连接断开，则清除记录
    socket.once("close", function() {
      delete self.clients[id];
      self.clientsCount--;
    });
    // 
    this.emit("connection", socket);
  }

  /**
   * Handles an Engine.IO HTTP Upgrade.
   *
   * @api public
   */
  // 处理websocket协议升级请求
  handleUpgrade(req, socket, upgradeHead) {
    // 解析query参数
    this.prepare(req);

    const self = this;
    this.verify(req, true, function(err, success) {
      if (!success) {
        abortConnection(socket, err);
        return;
      }

      const head = Buffer.from(upgradeHead); // eslint-disable-line node/no-deprecated-api
      upgradeHead = null;

      // delegate to ws 使用ws模块完成websocket的升级，ws回复同意升级协议后执行onWebSocket
      self.ws.handleUpgrade(req, socket, head, function(conn) {
        self.onWebSocket(req, conn);
      });
    });
  }

  /**
   * Called upon a ws.io connection.
   *
   * @param {ws.Socket} websocket
   * @api private
   */
  onWebSocket(req, socket) {
    socket.on("error", onUpgradeError);

    if (
      transports[req._query.transport] !== undefined &&
      !transports[req._query.transport].prototype.handlesUpgrades
    ) {
      debug("transport doesnt handle upgraded requests");
      socket.close();
      return;
    }

    // get client id
    const id = req._query.sid;

    // keep a reference to the ws.Socket
    req.websocket = socket;
    // 没有sid说明不是协议切换（升级），因为切换协议的话，客户端会先进行长轮询拿到一个sid，然后再进行切换
    if (id) {
      // 升级协议之前，该id对应的client已经存在，并且是没有升级完成的
      const client = this.clients[id];
      if (!client) {
        debug("upgrade attempt for closed client");
        socket.close();
      } else if (client.upgrading) {
        debug("transport has already been trying to upgrade");
        socket.close();
      } else if (client.upgraded) {
        debug("transport had already been upgraded");
        socket.close();
      } else {
        debug("upgrading existing transport");

        // transport error handling takes over
        socket.removeListener("error", onUpgradeError);
        // 新建一个新的通道，这里是websocket
        const transport = new transports[req._query.transport](req);
        if (req._query && req._query.b64) {
          transport.supportsBinary = false;
        } else {
          transport.supportsBinary = true;
        }
        transport.perMessageDeflate = this.perMessageDeflate;
        // 调用client的能力进行协议切换(socket.js)。这时候，等待客户端基于websocket发送ping包，然后服务器发送pong包。才真正完成通道的切换（升级）
        client.maybeUpgrade(transport);
      }
    } else {
      // transport error handling takes over
      socket.removeListener("error", onUpgradeError);
      // 没有sid说明是直接开始了websocket协议的连接
      this.handshake(req._query.transport, req);
    }

    function onUpgradeError() {
      debug("websocket error before upgrade");
      // socket.close() not needed
    }
  }

  /**
   * Captures upgrade requests for a http.Server.
   *
   * @param {http.Server} server
   * @param {Object} options
   * @api public
   */
  attach(server, options) {
    const self = this;
    options = options || {};
    let path = (options.path || "/engine.io").replace(/\/$/, "");

    const destroyUpgradeTimeout = options.destroyUpgradeTimeout || 1000;

    // normalize path
    path += "/";

    function check(req) {
      return path === req.url.substr(0, path.length);
    }

    // cache and clean up listeners
    // 解除之前的request事件，由本server接收
    const listeners = server.listeners("request").slice(0);
    server.removeAllListeners("request");
    server.on("close", self.close.bind(self));
    // listen成功后的回调
    server.on("listening", self.init.bind(self));

    // add request handler
    // 有http请求到达时的回调，支持long polling
    server.on("request", function(req, res) {
      // 判断是不是自己的请求（看路径）
      if (check(req)) {
        debug('intercepting request for path "%s"', path);
        self.handleRequest(req, res);
      } else {
        // 不是自己需要的请求，则回调http server的处理函数
        let i = 0;
        const l = listeners.length;
        for (; i < l; i++) {
          listeners[i].call(server, req, res);
        }
      }
    });
    // 定义了websocket作为传输通道
    if (~self.opts.transports.indexOf("websocket")) {
      // 监听upgrade事件
      server.on("upgrade", function(req, socket, head) {
        // 判断是不是自己的请求
        if (check(req)) {
          self.handleUpgrade(req, socket, head);
        } else if (false !== options.destroyUpgrade) {
          // default node behavior is to disconnect when no handlers
          // but by adding a handler, we prevent that
          // and if no eio thing handles the upgrade
          // then the socket needs to die!
          setTimeout(function() {
            if (socket.writable && socket.bytesWritten <= 0) {
              return socket.end();
            }
          }, destroyUpgradeTimeout);
        }
      });
    }
  }
}

/**
 * Protocol errors mappings.
 */

Server.errors = {
  UNKNOWN_TRANSPORT: 0,
  UNKNOWN_SID: 1,
  BAD_HANDSHAKE_METHOD: 2,
  BAD_REQUEST: 3,
  FORBIDDEN: 4
};

Server.errorMessages = {
  0: "Transport unknown",
  1: "Session ID unknown",
  2: "Bad handshake method",
  3: "Bad request",
  4: "Forbidden"
};

/**
 * Sends an Engine.IO Error Message
 *
 * @param {http.ServerResponse} response
 * @param {code} error code
 * @api private
 */

function sendErrorMessage(req, res, code) {
  const headers = { "Content-Type": "application/json" };

  const isForbidden = !Server.errorMessages.hasOwnProperty(code);
  if (isForbidden) {
    res.writeHead(403, headers);
    res.end(
      JSON.stringify({
        code: Server.errors.FORBIDDEN,
        message: code || Server.errorMessages[Server.errors.FORBIDDEN]
      })
    );
    return;
  }
  if (req.headers.origin) {
    headers["Access-Control-Allow-Credentials"] = "true";
    headers["Access-Control-Allow-Origin"] = req.headers.origin;
  } else {
    headers["Access-Control-Allow-Origin"] = "*";
  }
  if (res !== undefined) {
    res.writeHead(400, headers);
    res.end(
      JSON.stringify({
        code: code,
        message: Server.errorMessages[code]
      })
    );
  }
}

/**
 * Closes the connection
 *
 * @param {net.Socket} socket
 * @param {code} error code
 * @api private
 */

function abortConnection(socket, code) {
  socket.on("error", () => {
    debug("ignoring error from closed connection");
  });
  if (socket.writable) {
    const message = Server.errorMessages.hasOwnProperty(code)
      ? Server.errorMessages[code]
      : String(code || "");
    const length = Buffer.byteLength(message);
    socket.write(
      "HTTP/1.1 400 Bad Request\r\n" +
        "Connection: close\r\n" +
        "Content-type: text/html\r\n" +
        "Content-Length: " +
        length +
        "\r\n" +
        "\r\n" +
        message
    );
  }
  socket.destroy();
}

module.exports = Server;

/* eslint-disable */

/**
 * From https://github.com/nodejs/node/blob/v8.4.0/lib/_http_common.js#L303-L354
 *
 * True if val contains an invalid field-vchar
 *  field-value    = *( field-content / obs-fold )
 *  field-content  = field-vchar [ 1*( SP / HTAB ) field-vchar ]
 *  field-vchar    = VCHAR / obs-text
 *
 * checkInvalidHeaderChar() is currently designed to be inlinable by v8,
 * so take care when making changes to the implementation so that the source
 * code size does not exceed v8's default max_inlined_source_size setting.
 **/
// prettier-ignore
const validHdrChars = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, // 0 - 15
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, // 16 - 31
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 32 - 47
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 48 - 63
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 64 - 79
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 80 - 95
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 96 - 111
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, // 112 - 127
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, // 128 ...
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1  // ... 255
]

function checkInvalidHeaderChar(val) {
  val += "";
  if (val.length < 1) return false;
  if (!validHdrChars[val.charCodeAt(0)]) {
    debug('invalid header, index 0, char "%s"', val.charCodeAt(0));
    return true;
  }
  if (val.length < 2) return false;
  if (!validHdrChars[val.charCodeAt(1)]) {
    debug('invalid header, index 1, char "%s"', val.charCodeAt(1));
    return true;
  }
  if (val.length < 3) return false;
  if (!validHdrChars[val.charCodeAt(2)]) {
    debug('invalid header, index 2, char "%s"', val.charCodeAt(2));
    return true;
  }
  if (val.length < 4) return false;
  if (!validHdrChars[val.charCodeAt(3)]) {
    debug('invalid header, index 3, char "%s"', val.charCodeAt(3));
    return true;
  }
  for (let i = 4; i < val.length; ++i) {
    if (!validHdrChars[val.charCodeAt(i)]) {
      debug('invalid header, index "%i", char "%s"', i, val.charCodeAt(i));
      return true;
    }
  }
  return false;
}
