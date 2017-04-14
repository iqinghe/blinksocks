'use strict';Object.defineProperty(exports,'__esModule',{value:true});exports.ClientProxy=undefined;var _utils=require('../utils');var _socks=require('../proxies/socks5');var _socks2=require('../proxies/socks4');var _http=require('../proxies/http');var _common=require('../proxies/common');class ClientProxy{constructor(props){this._socksTcpReady=false;this._socksUdpReady=false;this._httpReady=false;this.onHandshakeDone=props.onHandshakeDone}isDone(){return[this._socksTcpReady,this._socksUdpReady,this._httpReady].some(v=>!!v)}makeHandshake(socket,buffer){this._trySocksHandshake(socket,buffer);if(!this.isDone()){this._tryHttpHandshake(socket,buffer)}}_trySocksHandshake(socket,buffer){if(!this.isDone()){this._trySocks5Handshake(socket,buffer)}if(!this.isDone()){this._trySocks4Handshake(socket,buffer)}}_trySocks4Handshake(socket,buffer){const request=_socks2.RequestMessage.parse(buffer);if(request!==null){const CMD=request.CMD,DSTIP=request.DSTIP,DSTADDR=request.DSTADDR,DSTPORT=request.DSTPORT;if(CMD===_common.REQUEST_COMMAND_CONNECT){const addr={type:DSTADDR.length>0?_common.ATYP_DOMAIN:_common.ATYP_V4,host:DSTADDR.length>0?DSTADDR:DSTIP,port:DSTPORT};this.onHandshakeDone(addr,()=>{const message=new _socks2.ReplyMessage({CMD:_common.REPLY_GRANTED});socket.write(message.toBuffer());this._socksTcpReady=true})}}}_trySocks5Handshake(socket,buffer){const identifier=_socks.IdentifierMessage.parse(buffer);if(identifier!==null){const message=new _socks.SelectMessage;socket.write(message.toBuffer());return}const request=_socks.RequestMessage.parse(buffer);if(request!==null){const type=request.CMD;switch(type){case _common.REQUEST_COMMAND_UDP:case _common.REQUEST_COMMAND_CONNECT:{const addr={type:request.ATYP,host:request.DSTADDR,port:request.DSTPORT};this.onHandshakeDone(addr,()=>{const message=new _socks.ReplyMessage({REP:_common.REPLY_SUCCEEDED});socket.write(message.toBuffer());if(type===_common.REQUEST_COMMAND_CONNECT){this._socksTcpReady=true}else{this._socksUdpReady=true}});break}default:{const message=new _socks.ReplyMessage({REP:_common.REPLY_COMMAND_NOT_SUPPORTED});socket.write(message.toBuffer());break}}}}_tryHttpHandshake(socket,buffer){const request=_http.HttpRequestMessage.parse(buffer);if(request!==null){const METHOD=request.METHOD,HOST=request.HOST;const addr=_utils.Utils.parseURI(HOST.toString());this.onHandshakeDone(addr,onForward=>{if(METHOD.toString()==='CONNECT'){const message=new _http.ConnectReplyMessage;socket.write(message.toBuffer())}else{onForward(buffer)}this._httpReady=true})}}}exports.ClientProxy=ClientProxy;