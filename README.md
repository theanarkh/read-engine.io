websocket原理：客户端通过http协议，发送一个协议升级的http报文，服务器解析http报文，发现需要升级协议到websocket，判断http头的内容，看是否满足条件，
满足然后返回一个http包同意切换协议。后续通信的时候，就是在tcp层面上发送websocket协议的数据包。在nodejs中，实现步骤是：
- 监听upgrade事件，收到一个协议升级的http报文时，nodejs会触发该事件，处理http头，然后回复一个同意升级的http报文，并保存tcp层的socket。通过socket实现推送功能。适合客户端支持websocket协议的情况。
- 监听request事件，nodejs在收到http请求时会触发这个事件。这种方式就和我们平时请求cgi一样。通过轮询的方式实现"推送"功能，适合客户端不支持websocket协议的情况。


1 engine.io模块
engine.io模块是socket.io模块的底层模块。他可以单独使用（作为服务器）。他不是websocket的实现，他是一个实现了"全双工"通信的引擎，有自己的协议格式（通过engine.io-parser模块进行数据的编码和解码），而websocket是实现这个功能的其中一种方式。engine.io分为几个子模块。

1.1 传输通道Transport
engine.io是一个实现了"全双工"通信的引擎，在客户端支持websocket协议的情况下，engine.io可以实现真正的全双工，如果客户端不支持websocket协议，engine.io则回退到长轮询。而长轮询分为两种方式，一种是XHR，一种是jsonp。以前三种实现双向通信的方式，就叫传输通道。

  1.1.1 websocket通道的实现
  websocket通道是对ws（websocket的实现）模块的封装，他在ws对象上注册message事件实现数据读取，根据自己的协议，封装好数据包后调用ws对象的send函数实现发送。

  1.1.2 jsonp、xhr通道的实现
  这两个通道都是通过http协议实现，实现原理就和一般的http请求一样，发送一个http请求，然后等待回包。

1.2 server
engine.io的服务器功能由server模块实现。实现原理是监听request和upgrade事件。engine.io调用ws模块完成http协议到websocket协议的升级。然后根据设置新建一条传输通道。如果底层是websocket协议，那么就由ws模块数据的读写。如果是长轮询，那么就通过注册request事件，拿到http协议的数据，处理完，然后回包。

engine.io和engine-client库实现双向通信功能流程。默认是使用long polling，然后升级到websocket

1 客户端发送一个http请求（形如GET https://myhost.com/socket.io/?EIO=3&transport=polling&t=ML4jUwU&b64=1），transport参数定义了，客户端想使用的通道。
2 服务器返回一个下面这样的数据包，告诉客户端sid和可用的协议
```
{
  "type": "open",
  "data": {
    "sid": "36Yib8-rSutGQYLfAAAD",  // the unique session id
    "upgrades": ["websocket"],      // the list of possible transport upgrades
    "pingInterval": 25000,          // the 1st parameter for the heartbeat mechanism
    "pingTimeout": 5000             // the 2nd parameter for the heartbeat mechanism
  }
}
```
3 客户端根据upgrades中的websocket值，再次发起请求，这是一个标准的http协议升级的请求，服务器回复101后，完成websocket协议的切换。
4 客户端再次发送一个ping包。
5 服务器回复pong包
6 客户端最后发送一个upgrade包
7 基于websocket协议的通信通道真正建立，可以开始通信。


# Engine.IO: the realtime engine

[![Build Status](https://travis-ci.org/socketio/engine.io.svg?branch=master)](http://travis-ci.org/socketio/engine.io)
[![NPM version](https://badge.fury.io/js/engine.io.svg)](http://badge.fury.io/js/engine.io)

`Engine.IO` is the implementation of transport-based
cross-browser/cross-device bi-directional communication layer for
[Socket.IO](http://github.com/socketio/socket.io).

## How to use

### Server

#### (A) Listening on a port

```js
var engine = require('engine.io');
var server = engine.listen(80);

server.on('connection', function(socket){
  socket.send('utf 8 string');
  socket.send(Buffer.from([0, 1, 2, 3, 4, 5])); // binary data
});
```

#### (B) Intercepting requests for a http.Server

```js
var engine = require('engine.io');
var http = require('http').createServer().listen(3000);
var server = engine.attach(http);

server.on('connection', function (socket) {
  socket.on('message', function(data){ });
  socket.on('close', function(){ });
});
```

#### (C) Passing in requests

```js
var engine = require('engine.io');
var server = new engine.Server();

server.on('connection', function(socket){
  socket.send('hi');
});

// …
httpServer.on('upgrade', function(req, socket, head){
  server.handleUpgrade(req, socket, head);
});
httpServer.on('request', function(req, res){
  server.handleRequest(req, res);
});
```

### Client

```html
<script src="/path/to/engine.io.js"></script>
<script>
  var socket = new eio.Socket('ws://localhost/');
  socket.on('open', function(){
    socket.on('message', function(data){});
    socket.on('close', function(){});
  });
</script>
```

For more information on the client refer to the
[engine-client](http://github.com/learnboost/engine.io-client) repository.

## What features does it have?

- **Maximum reliability**. Connections are established even in the presence of:
  - proxies and load balancers.
  - personal firewall and antivirus software.
  - for more information refer to **Goals** and **Architecture** sections
- **Minimal client size** aided by:
  - lazy loading of flash transports.
  - lack of redundant transports.
- **Scalable**
  - load balancer friendly
- **Future proof**
- **100% Node.JS core style**
  - No API sugar (left for higher level projects)
  - Written in readable vanilla JavaScript

## API

### Server

<hr><br>

#### Top-level

These are exposed by `require('engine.io')`:

##### Events

- `flush`
    - Called when a socket buffer is being flushed.
    - **Arguments**
      - `Socket`: socket being flushed
      - `Array`: write buffer
- `drain`
    - Called when a socket buffer is drained
    - **Arguments**
      - `Socket`: socket being flushed

##### Properties

- `protocol` _(Number)_: protocol revision number
- `Server`: Server class constructor
- `Socket`: Socket class constructor
- `Transport` _(Function)_: transport constructor
- `transports` _(Object)_: map of available transports

##### Methods

- `()`
    - Returns a new `Server` instance. If the first argument is an `http.Server` then the
      new `Server` instance will be attached to it. Otherwise, the arguments are passed
      directly to the `Server` constructor.
    - **Parameters**
      - `http.Server`: optional, server to attach to.
      - `Object`: optional, options object (see `Server#constructor` api docs below)

  The following are identical ways to instantiate a server and then attach it.

```js
var httpServer; // previously created with `http.createServer();` from node.js api.

// create a server first, and then attach
var eioServer = require('engine.io').Server();
eioServer.attach(httpServer);

// or call the module as a function to get `Server`
var eioServer = require('engine.io')();
eioServer.attach(httpServer);

// immediately attach
var eioServer = require('engine.io')(httpServer);

// with custom options
var eioServer = require('engine.io')(httpServer, {
  maxHttpBufferSize: 1e3
});
```

- `listen`
    - Creates an `http.Server` which listens on the given port and attaches WS
      to it. It returns `501 Not Implemented` for regular http requests.
    - **Parameters**
      - `Number`: port to listen on.
      - `Object`: optional, options object
      - `Function`: callback for `listen`.
    - **Options**
      - All options from `Server.attach` method, documented below.
      - **Additionally** See Server `constructor` below for options you can pass for creating the new Server
    - **Returns** `Server`

```js
var engine = require('engine.io');
var server = engine.listen(3000, {
  pingTimeout: 2000,
  pingInterval: 10000
});

server.on('connection', /* ... */);
```

- `attach`
    - Captures `upgrade` requests for a `http.Server`. In other words, makes
      a regular http.Server WebSocket-compatible.
    - **Parameters**
      - `http.Server`: server to attach to.
      - `Object`: optional, options object
    - **Options**
      - All options from `Server.attach` method, documented below.
      - **Additionally** See Server `constructor` below for options you can pass for creating the new Server
    - **Returns** `Server` a new Server instance.

```js
var engine = require('engine.io');
var httpServer = require('http').createServer().listen(3000);
var server = engine.attach(httpServer, {
  wsEngine: 'uws' // requires having uws as dependency
});

server.on('connection', /* ... */);
```

#### Server

The main server/manager. _Inherits from EventEmitter_.

##### Events

- `connection`
    - Fired when a new connection is established.
    - **Arguments**
      - `Socket`: a Socket object

##### Properties

**Important**: if you plan to use Engine.IO in a scalable way, please
keep in mind the properties below will only reflect the clients connected
to a single process.

- `clients` _(Object)_: hash of connected clients by id.
- `clientsCount` _(Number)_: number of connected clients.

##### Methods

- **constructor**
    - Initializes the server
    - **Parameters**
      - `Object`: optional, options object
    - **Options**
      - `pingTimeout` (`Number`): how many ms without a pong packet to
        consider the connection closed (`5000`)
      - `pingInterval` (`Number`): how many ms before sending a new ping
        packet (`25000`)
      - `upgradeTimeout` (`Number`): how many ms before an uncompleted transport upgrade is cancelled (`10000`)
      - `maxHttpBufferSize` (`Number`): how many bytes or characters a message
        can be, before closing the session (to avoid DoS). Default
        value is `10E7`.
      - `allowRequest` (`Function`): A function that receives a given handshake
        or upgrade request as its first parameter, and can decide whether to
        continue or not. The second argument is a function that needs to be
        called with the decided information: `fn(err, success)`, where
        `success` is a boolean value where false means that the request is
        rejected, and err is an error code.
      - `transports` (`<Array> String`): transports to allow connections
        to (`['polling', 'websocket']`)
      - `allowUpgrades` (`Boolean`): whether to allow transport upgrades
        (`true`)
      - `perMessageDeflate` (`Object|Boolean`): parameters of the WebSocket permessage-deflate extension
        (see [ws module](https://github.com/einaros/ws) api docs). Set to `false` to disable. (`true`)
        - `threshold` (`Number`): data is compressed only if the byte size is above this value (`1024`)
      - `httpCompression` (`Object|Boolean`): parameters of the http compression for the polling transports
        (see [zlib](http://nodejs.org/api/zlib.html#zlib_options) api docs). Set to `false` to disable. (`true`)
        - `threshold` (`Number`): data is compressed only if the byte size is above this value (`1024`)
      - `cookie` (`Object|Boolean`): configuration of the cookie that
        contains the client sid to send as part of handshake response
        headers. This cookie might be used for sticky-session. Defaults to not sending any cookie (`false`).
        See [here](https://github.com/jshttp/cookie#options-1) for all supported options.
      - `wsEngine` (`String`): what WebSocket server implementation to use. Specified module must conform to the `ws` interface (see [ws module api docs](https://github.com/websockets/ws/blob/master/doc/ws.md)). Default value is `ws`. An alternative c++ addon is also available by installing `uws` module.
      - `cors` (`Object`): the options that will be forwarded to the cors module. See [there](https://github.com/expressjs/cors#configuration-options) for all available options. Defaults to no CORS allowed.
      - `initialPacket` (`Object`): an optional packet which will be concatenated to the handshake packet emitted by Engine.IO.
- `close`
    - Closes all clients
    - **Returns** `Server` for chaining
- `handleRequest`
    - Called internally when a `Engine` request is intercepted.
    - **Parameters**
      - `http.IncomingMessage`: a node request object
      - `http.ServerResponse`: a node response object
    - **Returns** `Server` for chaining
- `handleUpgrade`
    - Called internally when a `Engine` ws upgrade is intercepted.
    - **Parameters** (same as `upgrade` event)
      - `http.IncomingMessage`: a node request object
      - `net.Stream`: TCP socket for the request
      - `Buffer`: legacy tail bytes
    - **Returns** `Server` for chaining
- `attach`
    - Attach this Server instance to an `http.Server`
    - Captures `upgrade` requests for a `http.Server`. In other words, makes
      a regular http.Server WebSocket-compatible.
    - **Parameters**
      - `http.Server`: server to attach to.
      - `Object`: optional, options object
    - **Options**
      - `path` (`String`): name of the path to capture (`/engine.io`).
      - `destroyUpgrade` (`Boolean`): destroy unhandled upgrade requests (`true`)
      - `destroyUpgradeTimeout` (`Number`): milliseconds after which unhandled requests are ended (`1000`)
- `generateId`
    - Generate a socket id.
    - Overwrite this method to generate your custom socket id.
    - **Parameters**
      - `http.IncomingMessage`: a node request object
  - **Returns** A socket id for connected client.

<hr><br>

#### Socket

A representation of a client. _Inherits from EventEmitter_.

##### Events

- `close`
    - Fired when the client is disconnected.
    - **Arguments**
      - `String`: reason for closing
      - `Object`: description object (optional)
- `message`
    - Fired when the client sends a message.
    - **Arguments**
      - `String` or `Buffer`: Unicode string or Buffer with binary contents
- `error`
    - Fired when an error occurs.
    - **Arguments**
      - `Error`: error object
- `flush`
    - Called when the write buffer is being flushed.
    - **Arguments**
      - `Array`: write buffer
- `drain`
    - Called when the write buffer is drained
- `packet`
    - Called when a socket received a packet (`message`, `ping`)
    - **Arguments**
      - `type`: packet type
      - `data`: packet data (if type is message)
- `packetCreate`
    - Called before a socket sends a packet (`message`, `ping`)
    - **Arguments**
      - `type`: packet type
      - `data`: packet data (if type is message)

##### Properties

- `id` _(String)_: unique identifier
- `server` _(Server)_: engine parent reference
- `request` _(http.IncomingMessage)_: request that originated the Socket
- `upgraded` _(Boolean)_: whether the transport has been upgraded
- `readyState` _(String)_: opening|open|closing|closed
- `transport` _(Transport)_: transport reference

##### Methods

- `send`:
    - Sends a message, performing `message = toString(arguments[0])` unless
      sending binary data, which is sent as is.
    - **Parameters**
      - `String` | `Buffer` | `ArrayBuffer` | `ArrayBufferView`: a string or any object implementing `toString()`, with outgoing data, or a Buffer or ArrayBuffer with binary data. Also any ArrayBufferView can be sent as is.
      - `Object`: optional, options object
      - `Function`: optional, a callback executed when the message gets flushed out by the transport
    - **Options**
      - `compress` (`Boolean`): whether to compress sending data. This option might be ignored and forced to be `true` when using polling. (`true`)
    - **Returns** `Socket` for chaining
- `close`
    - Disconnects the client
    - **Returns** `Socket` for chaining

### Client

<hr><br>

Exposed in the `eio` global namespace (in the browser), or by
`require('engine.io-client')` (in Node.JS).

For the client API refer to the
[engine-client](http://github.com/learnboost/engine.io-client) repository.

## Debug / logging

Engine.IO is powered by [debug](http://github.com/visionmedia/debug).
In order to see all the debug output, run your app with the environment variable
`DEBUG` including the desired scope.

To see the output from all of Engine.IO's debugging scopes you can use:

```
DEBUG=engine* node myapp
```

## Transports

- `polling`: XHR / JSONP polling transport.
- `websocket`: WebSocket transport.

## Plugins

- [engine.io-conflation](https://github.com/EugenDueck/engine.io-conflation): Makes **conflation and aggregation** of messages straightforward.

## Support

The support channels for `engine.io` are the same as `socket.io`:
  - irc.freenode.net **#socket.io**
  - [Google Groups](http://groups.google.com/group/socket_io)
  - [Website](http://socket.io)

## Development

To contribute patches, run tests or benchmarks, make sure to clone the
repository:

```
git clone git://github.com/LearnBoost/engine.io.git
```

Then:

```
cd engine.io
npm install
```

## Tests

Tests run with `npm test`. It runs the server tests that are aided by
the usage of `engine.io-client`.

Make sure `npm install` is run first.

## Goals

The main goal of `Engine` is ensuring the most reliable realtime communication.
Unlike the previous Socket.IO core, it always establishes a long-polling
connection first, then tries to upgrade to better transports that are "tested" on
the side.

During the lifetime of the Socket.IO projects, we've found countless drawbacks
to relying on `HTML5 WebSocket` or `Flash Socket` as the first connection
mechanisms.

Both are clearly the _right way_ of establishing a bidirectional communication,
with HTML5 WebSocket being the way of the future. However, to answer most business
needs, alternative traditional HTTP 1.1 mechanisms are just as good as delivering
the same solution.

WebSocket based connections have two fundamental benefits:

1. **Better server performance**
  - _A: Load balancers_<br>
      Load balancing a long polling connection poses a serious architectural nightmare
      since requests can come from any number of open sockets by the user agent, but
      they all need to be routed to the process and computer that owns the `Engine`
      connection. This negatively impacts RAM and CPU usage.
  - _B: Network traffic_<br>
      WebSocket is designed around the premise that each message frame has to be
      surrounded by the least amount of data. In HTTP 1.1 transports, each message
      frame is surrounded by HTTP headers and chunked encoding frames. If you try to
      send the message _"Hello world"_ with xhr-polling, the message ultimately
      becomes larger than if you were to send it with WebSocket.
  - _C: Lightweight parser_<br>
      As an effect of **B**, the server has to do a lot more work to parse the network
      data and figure out the message when traditional HTTP requests are used
      (as in long polling). This means that another advantage of WebSocket is
      less server CPU usage.

2. **Better user experience**

    Due to the reasons stated in point **1**, the most important effect of being able
    to establish a WebSocket connection is raw data transfer speed, which translates
    in _some_ cases in better user experience.

    Applications with heavy realtime interaction (such as games) will benefit greatly,
    whereas applications like realtime chat (Gmail/Facebook), newsfeeds (Facebook) or
    timelines (Twitter) will have negligible user experience improvements.

Having said this, attempting to establish a WebSocket connection directly so far has
proven problematic:

1. **Proxies**<br>
    Many corporate proxies block WebSocket traffic.

2. **Personal firewall and antivirus software**<br>
    As a result of our research, we've found that at least 3 personal security
    applications block WebSocket traffic.

3. **Cloud application platforms**<br>
    Platforms like Heroku or No.de have had trouble keeping up with the fast-paced
    nature of the evolution of the WebSocket protocol. Applications therefore end up
    inevitably using long polling, but the seamless installation experience of
    Socket.IO we strive for (_"require() it and it just works"_) disappears.

Some of these problems have solutions. In the case of proxies and personal programs,
however, the solutions many times involve upgrading software. Experience has shown
that relying on client software upgrades to deliver a business solution is
fruitless: the very existence of this project has to do with a fragmented panorama
of user agent distribution, with clients connecting with latest versions of the most
modern user agents (Chrome, Firefox and Safari), but others with versions as low as
IE 5.5.

From the user perspective, an unsuccessful WebSocket connection can translate in
up to at least 10 seconds of waiting for the realtime application to begin
exchanging data. This **perceptively** hurts user experience.

To summarize, **Engine** focuses on reliability and user experience first, marginal
potential UX improvements and increased server performance second. `Engine` is the
result of all the lessons learned with WebSocket in the wild.

## Architecture

The main premise of `Engine`, and the core of its existence, is the ability to
swap transports on the fly. A connection starts as xhr-polling, but it can
switch to WebSocket.

The central problem this poses is: how do we switch transports without losing
messages?

`Engine` only switches from polling to another transport in between polling
cycles. Since the server closes the connection after a certain timeout when
there's no activity, and the polling transport implementation buffers messages
in between connections, this ensures no message loss and optimal performance.

Another benefit of this design is that we workaround almost all the limitations
of **Flash Socket**, such as slow connection times, increased file size (we can
safely lazy load it without hurting user experience), etc.

## FAQ

### Can I use engine without Socket.IO ?

Absolutely. Although the recommended framework for building realtime applications
is Socket.IO, since it provides fundamental features for real-world applications
such as multiplexing, reconnection support, etc.

`Engine` is to Socket.IO what Connect is to Express. An essential piece for building
realtime frameworks, but something you _probably_ won't be using for building
actual applications.

### Does the server serve the client?

No. The main reason is that `Engine` is meant to be bundled with frameworks.
Socket.IO includes `Engine`, therefore serving two clients is not necessary. If
you use Socket.IO, including

```html
<script src="/socket.io/socket.io.js">
```

has you covered.

### Can I implement `Engine` in other languages?

Absolutely. The [engine.io-protocol](https://github.com/LearnBoost/engine.io-protocol)
repository contains the most up to date description of the specification
at all times, and the parser implementation in JavaScript.

## License

(The MIT License)

Copyright (c) 2014 Guillermo Rauch &lt;guillermo@learnboost.com&gt;

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
'Software'), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
