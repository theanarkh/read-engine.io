const EventEmitter = require("events");
const parser = require("engine.io-parser");
const debug = require("debug")("engine:transport");

/**
 * Noop function.
 *
 * @api private
 */

function noop() {}
// 传输通道基类
class Transport extends EventEmitter {
  /**
   * Transport constructor.
   *
   * @param {http.IncomingMessage} request
   * @api public
   */
  constructor(req) {
    super();
    this.readyState = "open";
    this.discarded = false;
  }

  /**
   * Flags the transport as discarded.
   *
   * @api private
   */
  discard() {
    this.discarded = true;
  }

  /**
   * Called with an incoming HTTP request.
   *
   * @param {http.IncomingMessage} request
   * @api private
   */
  // 有请求到来时执行
  onRequest(req) {
    debug("setting request");
    this.req = req;
  }

  /**
   * Closes the transport.
   *
   * @api private
   */
  close(fn) {
    if ("closed" === this.readyState || "closing" === this.readyState) return;

    this.readyState = "closing";
    this.doClose(fn || noop);
  }

  /**
   * Called with a transport error.
   *
   * @param {String} message error
   * @param {Object} error description
   * @api private
   */
  onError(msg, desc) {
    if (this.listeners("error").length) {
      const err = new Error(msg);
      err.type = "TransportError";
      err.description = desc;
      this.emit("error", err);
    } else {
      debug("ignored transport error %s (%s)", msg, desc);
    }
  }

  /**
   * Called with parsed out a packets from the data stream.
   *
   * @param {Object} packet
   * @api private
   */
  // 对数据解码后执行
  onPacket(packet) {
    this.emit("packet", packet);
  }

  /**
   * Called with the encoded packet data.
   *
   * @param {String} data
   * @api private
   */
  // 有数据到来时执行
  onData(data) {
    this.onPacket(parser.decodePacket(data));
  }

  /**
   * Called upon transport close.
   *
   * @api private
   */
  onClose() {
    this.readyState = "closed";
    this.emit("close");
  }
}

module.exports = Transport;
