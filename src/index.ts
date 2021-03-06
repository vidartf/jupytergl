

import {
  Kernel, KernelMessage
} from '@jupyterlab/services';

import {
  JSONArray, JSONValue, JSONPrimitive, JSONObject
} from './json';

import {
  IMessage, IReply, IConstantsReply, IMethodsReply, IQueryReply, IQueryError,
  ICommand
} from './comm';

import {
  threeOrbit, ThreeOrbitView
} from './views';


// Re-export:
export {
  startCommListen
} from './comm';


function availableMethods(gl: WebGLRenderingContext): string[] {
  let ret: string[] = [];
  for (let key in gl) {
    if (typeof (gl as any)[key] === 'function') {
      ret.push(key);
    }
  }
  return ret;
}


const nonConstKeys = ['drawingBufferWidth', 'drawingBufferHeight'];

function availableConstants(gl: WebGLRenderingContext): {[key: string]: number} {
  let ret: {[key: string]: number} = {};
  for (let key in gl) {
    if (nonConstKeys.indexOf(key) !== -1) {
      continue;
    } else if (typeof (gl as any)[key] === 'number') {
      ret[key] = (gl as any)[key];
    }
  }
  return ret;
}


export
interface IInstruction extends JSONObject {
  type: 'exec' | 'query';
  op: string;
  args: JSONArray;
}


export
type Buffer = ArrayBuffer | ArrayBufferView;


type BufferTypeKey =   'uint8' | 'int8' | 'uint8C' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64';
const bufferViewMap = {
  'uint8': Uint8Array,
  'int8': Int8Array,
  'uint8C': Uint8ClampedArray,
  'int16': Int16Array,
  'uint16': Uint16Array,
  'int32': Int32Array,
  'uint32': Uint32Array,
  'float32': Float32Array,
  'float64': Float64Array
}


export
class Context {
  /**
   *
   */
  constructor(parentNode: HTMLElement) {
    this.parentNode = parentNode;
    this.variables = {};
  }

  get context(): WebGLRenderingContext {
    if (this._context === null) {
      let canvas = document.createElement('canvas');
      this.parentNode.appendChild(canvas);
      let context = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (context === null) {
        throw TypeError('Could not get WebGL context for canvas!');
      }
      this._context = context;
    }
    return this._context;
  }


  protected messageBufferContext(buffers: Buffer[], inner: () => void): void {
    try {
      this._currentBuffers = buffers;
      inner();
    } finally {
      this._currentBuffers = null;
    }
  }


  handleMessage(comm: Kernel.IComm, message: KernelMessage.ICommMsgMsg): void {
    let data = message.content.data as IMessage;
    if (data.type === 'exec') {
      let instructions = data.instructions;
      this.messageBufferContext(message.buffers, () => {
        this.execMessage(this.context, instructions);
      });
    } else if (data.type === 'query') {
      let instructions = data.instructions;
      this.messageBufferContext(message.buffers, () => {
        let result : any;
        let reply: IQueryReply | IQueryError;
        try {
          result = this.queryMessage(this.context, instructions);
          reply = {
            type: 'queryReply',
            data: result
          };
        } catch (e) {
          if (e instanceof TypeError) {
            reply = {
              type: 'queryError',
              data: {
                message: e.message
              }
            }
          } else {
            throw e;
          }
        }
        comm.send(reply, message.metadata)
      });
    } else if (data.type === 'getConstants' || data.type === 'getMethods') {
      if (data.target === 'context') {
        let reply: IReply;
        if (data.type === 'getConstants') {
          let constants = availableConstants(this.context);
          reply = {
            type: 'constantsReply',
            target: data.target,
            data: constants
          } as IConstantsReply;
        } else {
          let methods = availableMethods(this.context);
          reply = {
            type: 'methodsReply',
            target: data.target,
            data: methods
          } as IMethodsReply;
        }
        comm.send(reply, message.metadata)
      }
    } else if (data.type === 'command') {
      this.handleCommand(data.command)
    }
  }


  handleCommand(data: ICommand) {
    if (data.op === 'orbitView') {
      if (this._view) {
        this._view.remove();
      }
      this._view = threeOrbit(this, data.args, () => {
        this.execMessage(this.context, data.instructions);
      });
    }
  }

  execMessage(gl: WebGLRenderingContext, message: IInstruction[]): void {
    for (let instruction of message) {
      this.execInstruction(gl, instruction);
    }
  }



  queryMessage(gl: WebGLRenderingContext, message: IInstruction[]): JSONValue {
    for (let i = 0; i < message.length - 1; ++i) {
      this.execInstruction(gl, message[i]);
    }
    return this.queryInstruction(gl, message[message.length - 1]);
  }


  protected expandArgs(args: JSONArray): any[] {
    let ret: any[] = [];
    for (let arg of args) {
      if (typeof arg === 'string') {
        if (arg.slice(0, 6) === 'buffer') {
          let bufType = arg.slice(6) as BufferTypeKey;
          let raw = this._currentBuffers!.shift()!;
          if (ArrayBuffer.isView(raw)) {
            raw = raw.buffer;
          }
          let view = new bufferViewMap[bufType](raw);
          ret.push(view);
        } else if (arg.slice(0, 3) === 'key') {
          ret.push(this.variables[arg]);
        } else {
          ret.push(arg);
        }
      } else {
        ret.push(arg);
      }
    }
    return ret;
  }


  /**
   * Execute an instruction, discarding any return value.
   *
   * Throws an error if instruction is missing.
   */
  protected execInstruction(gl: WebGLRenderingContext, instruction: IInstruction): void {
    (gl as any)[instruction.op](...this.expandArgs(instruction.args));
  }


  /**
   * Process an instruction, returning its return value.
   *
   * Throws an error if instruction is missing.
   */
  protected queryInstruction(gl: WebGLRenderingContext, instruction: IInstruction): JSONValue {
    let result = (gl as any)[instruction.op](...this.expandArgs(instruction.args));
    if (result === undefined) {
      result = null;
    }
    if (result === null || typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') {
      return result as JSONPrimitive;
    }
    // We have received a reference that needs to be stored locally.
    let key = 'key' + this.variableIdGen++;
    this.variables[key] = result;
    return key;
  }

  protected variables: {[key: string]: any};

  protected variableIdGen = 1;

  protected parentNode: HTMLElement;

  private _currentBuffers: Buffer[] | null = null;

  private _context: WebGLRenderingContext | null = null;

  private _view: ThreeOrbitView | null = null;
}


export
class DebugContex extends Context {


  handleMessage(comm: Kernel.IComm, message: KernelMessage.ICommMsgMsg): void {
    let data = message.content.data as IMessage;
    if (data.type !== 'exec' && data.type !== 'query') {
      console.log(data.type);
    }
    return super.handleMessage(comm, message);
  }

  /**
   * Execute an instruction, discarding any return value.
   *
   * Throws an error if instruction is missing.
   */
  protected execInstruction(gl: WebGLRenderingContext, instruction: IInstruction): void {
    console.log('exec ' + instruction.op);
    return super.execInstruction(gl, instruction);
  }


  /**
   * Process an instruction, returning its return value.
   *
   * Throws an error if instruction is missing.
   */
  protected queryInstruction(gl: WebGLRenderingContext, instruction: IInstruction): JSONValue {
    console.log('query ' + instruction.op);
    return super.queryInstruction(gl, instruction);
  }
}

