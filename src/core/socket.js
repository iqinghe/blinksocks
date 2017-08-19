import EventEmitter from 'events';
import net from 'net';
import {Logger, isValidHostname, isValidPort} from '../utils';
import {Config} from './config';
import {DNSCache} from './dns-cache';
import {Balancer} from './balancer';
import {Pipe} from './pipe';
import {
  MIDDLEWARE_DIRECTION_UPWARD,
  MIDDLEWARE_DIRECTION_DOWNWARD,
  createMiddleware
} from './middleware';

import {
  CONNECTION_CREATED,
  CONNECTION_CLOSED,
  SOCKET_CONNECT_TO_REMOTE,
  PROCESSING_FAILED
} from '../presets/defs';

import {BEHAVIOUR_EVENT_ON_PRESET_FAILED} from '../behaviours';

const MAX_BUFFERED_SIZE = 1024 * 1024; // 1MB

let logger = null;
let lastServer = null;

function selectServer() {
  const server = Balancer.getFastest();
  if (lastServer === null || server.id !== lastServer.id) {
    Config.initServer(server);
    lastServer = server;
    logger.info(`[balancer] use: ${server.host}:${server.port}`);
  }
}

/**
 * @description
 *   socket layer which handles both backward socket and forward socket.
 *
 * @events
 *   .on('close', () => {});
 */
export class Socket extends EventEmitter {

  _dnsCache = null;

  _isConnectedToDst = false;

  _remoteHost = '';

  _remotePort = '';

  _bsocket = null;

  _fsocket = null;

  _pipe = null;

  constructor({socket}) {
    super();
    logger = Logger.getInstance();
    this.onForward = this.onForward.bind(this);
    this.onBackward = this.onBackward.bind(this);
    this.onError = this.onError.bind(this);
    this.onBackwardSocketDrain = this.onBackwardSocketDrain.bind(this);
    this.onBackwardSocketTimeout = this.onBackwardSocketTimeout.bind(this);
    this.onBackwardSocketClose = this.onBackwardSocketClose.bind(this);
    this.onForwardSocketDrain = this.onForwardSocketDrain.bind(this);
    this.onForwardSocketTimeout = this.onForwardSocketTimeout.bind(this);
    this.onForwardSocketClose = this.onForwardSocketClose.bind(this);
    this._dnsCache = new DNSCache({expire: __DNS_EXPIRE__});
    this._remoteHost = socket.remoteAddress;
    this._remotePort = socket.remotePort;
    this._bsocket = socket;
    this._bsocket.on('error', this.onError);
    this._bsocket.on('close', this.onBackwardSocketClose);
    this._bsocket.on('timeout', this.onBackwardSocketTimeout.bind(this, {
      host: this._remoteHost,
      port: this._remotePort
    }));
    this._bsocket.on('data', this.onForward);
    this._bsocket.on('drain', this.onBackwardSocketDrain);
    this._bsocket.setTimeout(__TIMEOUT__);
    if (__IS_CLIENT__) {
      selectServer();
    }
    this._pipe = this.createPipe();
    this._pipe.onBroadcast({
      type: CONNECTION_CREATED,
      payload: {
        host: this._remoteHost,
        port: this._remotePort
      }
    });
  }

  // getters

  get remote() {
    return `${this._remoteHost}:${this._remotePort}`;
  }

  get fsocketWritable() {
    return this._fsocket && !this._fsocket.destroyed && this._fsocket.writable;
  }

  get bsocketWritable() {
    return this._bsocket && !this._bsocket.destroyed && this._bsocket.writable;
  }

  // events

  onError(err) {
    logger.warn(`[socket] [${this.remote}] ${err.code} - ${err.message}`);
  }

  // bsocket

  onForward(buffer) {
    if (this.fsocketWritable || !this._isConnectedToDst) {
      const direction = __IS_CLIENT__ ? MIDDLEWARE_DIRECTION_UPWARD : MIDDLEWARE_DIRECTION_DOWNWARD;
      this._pipe.feed(direction, buffer);
    }
    // throttle receiving data to reduce memory grow:
    // https://github.com/blinksocks/blinksocks/issues/60
    if (this._fsocket && this._fsocket.bufferSize >= MAX_BUFFERED_SIZE) {
      this._bsocket.pause();
    }
  }

  onForwardSocketDrain() {
    if (this._bsocket && !this._bsocket.destroyed) {
      this._bsocket.resume();
    }
  }

  onForwardSocketTimeout({host, port}) {
    logger.warn(`[socket] [${host}:${port}] timeout: no I/O on the connection for ${__TIMEOUT__ / 1e3}s`);
    this.onForwardSocketClose();
  }

  onForwardSocketClose() {
    if (this._fsocket) {
      this._fsocket.destroy();
      this._fsocket = null;
    }
    if (this._bsocket) {
      if (this._bsocket.bufferSize > 0) {
        this._bsocket.on('drain', this.onBackwardSocketClose);
      } else {
        this.onBackwardSocketClose();
      }
    }
  }

  // fsocket

  onBackward(buffer) {
    if (this.bsocketWritable) {
      const direction = __IS_CLIENT__ ? MIDDLEWARE_DIRECTION_DOWNWARD : MIDDLEWARE_DIRECTION_UPWARD;
      this._pipe.feed(direction, buffer);
    }
    // throttle receiving data to reduce memory grow:
    // https://github.com/blinksocks/blinksocks/issues/60
    if (this._bsocket && this._bsocket.bufferSize >= MAX_BUFFERED_SIZE) {
      this._fsocket.pause();
    }
  }

  onBackwardSocketDrain() {
    if (this._fsocket && !this._fsocket.destroyed) {
      this._fsocket.resume();
    }
  }

  onBackwardSocketTimeout({host, port}) {
    logger.warn(`[socket] [${host}:${port}] timeout: no I/O on the connection for ${__TIMEOUT__ / 1e3}s`);
    this.onBackwardSocketClose();
  }

  onBackwardSocketClose() {
    if (this._bsocket) {
      this._bsocket.destroy();
      this._bsocket = null;
      this._pipe.onBroadcast({
        type: CONNECTION_CLOSED,
        payload: {
          host: this._remoteHost,
          port: this._remotePort
        }
      });
      this._pipe.destroy();
      this._pipe = null;
      this.emit('close');
    }
    if (this._fsocket) {
      if (this._fsocket.bufferSize > 0) {
        this._fsocket.on('drain', this.onForwardSocketClose);
      } else {
        this.onForwardSocketClose();
      }
    }
  }

  // methods

  sendForward(buffer) {
    if (__IS_CLIENT__) {
      this.fsocketWritable && this._fsocket.write(buffer);
    } else {
      this.bsocketWritable && this._bsocket.write(buffer);
    }
  }

  sendBackward(buffer) {
    if (__IS_CLIENT__) {
      this.bsocketWritable && this._bsocket.write(buffer);
    } else {
      this.fsocketWritable && this._fsocket.write(buffer);
    }
  }

  /**
   * connect to another endpoint, for both client and server
   * @param host
   * @param port
   * @returns {Promise}
   */
  async connect({host, port}) {
    // host could be empty, see https://github.com/blinksocks/blinksocks/issues/34
    if (!isValidHostname(host) || !isValidPort(port)) {
      logger.warn(`unexpected host=${host} port=${port}`);
      this.onBackwardSocketClose();
      return;
    }
    logger.info(`[socket] [${this.remote}] connecting to: ${host}:${port}`);
    // resolve host name
    let ip = null;
    try {
      ip = await this._dnsCache.get(host);
    } catch (err) {
      logger.error(`[socket] [${this.remote}] fail to resolve host ${host}:${port}: ${err.message}`);
    }
    return new Promise((resolve) => {
      this._fsocket = net.connect({host: ip, port}, () => resolve(this._fsocket));
      this._fsocket.on('error', this.onError);
      this._fsocket.on('close', this.onForwardSocketClose);
      this._fsocket.on('timeout', this.onForwardSocketTimeout.bind(this, {host, port}));
      this._fsocket.on('data', this.onBackward);
      this._fsocket.on('drain', this.onForwardSocketDrain);
      this._fsocket.setTimeout(__TIMEOUT__);
    });
  }

  /**
   * create pipes for both data forward and backward
   */
  createPipe() {
    let presets = __PRESETS__;
    // prepend "proxy" preset to the top of presets on client side
    if (__IS_CLIENT__ && presets[0].name !== 'proxy') {
      presets = [{name: 'proxy'}].concat(presets);
    }
    // add "tracker" preset to the preset list on both sides
    if (presets[presets.length - 1].name !== 'tracker') {
      presets = presets.concat([{name: 'tracker'}]);
    }
    // create middlewares and pipe
    const middlewares = presets.map((preset) => createMiddleware(preset.name, preset.params || {}));
    const pipe = new Pipe({onNotified: this.onPipeNotified.bind(this)});
    pipe.setMiddlewares(MIDDLEWARE_DIRECTION_UPWARD, middlewares);
    pipe.on(`next_${MIDDLEWARE_DIRECTION_UPWARD}`, this.sendForward.bind(this));
    pipe.on(`next_${MIDDLEWARE_DIRECTION_DOWNWARD}`, this.sendBackward.bind(this));
    return pipe;
  }

  /**
   * if no action were caught by middlewares
   * @param action
   * @returns {*}
   */
  async onPipeNotified(action) {
    const props = {
      remoteAddr: this.remote,
      bsocket: this._bsocket,
      fsocket: this._fsocket,
      connect: this.connect.bind(this),
      action: action
    };
    switch (action.type) {
      case SOCKET_CONNECT_TO_REMOTE: {
        const {host, port, onConnected} = action.payload;
        if (__IS_SERVER__) {
          // connect to destination
          await this.connect({host, port});
        }
        if (__IS_CLIENT__) {
          logger.info(`[socket] [${this.remote}] request: ${host}:${port}`);
          // select a server from Balancer
          selectServer();
          // connect to our server
          await this.connect({host: __SERVER_HOST__, port: __SERVER_PORT__});
        }
        this._isConnectedToDst = true;
        if (typeof onConnected === 'function') {
          onConnected();
        }
        break;
      }
      case PROCESSING_FAILED: {
        const {name, message} = action.payload;
        logger.error(`[socket] [${this.remote}] preset "${name}" fail to process: ${message}`);
        await __BEHAVIOURS__[BEHAVIOUR_EVENT_ON_PRESET_FAILED].run(props);
        break;
      }
      default:
        break;
    }
  }

  /**
   * close both sides
   */
  destroy() {
    this.onForwardSocketClose();
    this.onBackwardSocketClose();
  }

}
