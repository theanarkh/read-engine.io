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
<br/>
3 客户端根据upgrades中的websocket值，再次发起请求，这是一个标准的http协议升级的请求，服务器回复101后，完成websocket协议的切换。
<br/>
4 客户端再次发送一个ping包。
<br/>
5 服务器回复pong包
<br/>
6 客户端最后发送一个upgrade包
<br/>
7 基于websocket协议的通信通道真正建立，可以开始通信。
