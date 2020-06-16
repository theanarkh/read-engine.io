const XHR = require("./polling");
const JSONP = require("./polling-jsonp");

/**
 * Export transports.
 */
// 三种传输通道
module.exports = exports = {
  // 轮询分为两种，xhr和jsonp
  polling: polling,
  // websocket
  websocket: require("./websocket")
};

/**
 * Export upgrades map.
 */
// polling可切换到websocket
exports.polling.upgradesTo = ["websocket"];

/**
 * Polling polymorphic constructor.
 *
 * @api private
 */

function polling(req) {
  if ("string" === typeof req._query.j) {
    return new JSONP(req);
  } else {
    return new XHR(req);
  }
}
