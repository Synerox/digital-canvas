var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// node_modules/@yowasp/runtime/lib/fetch.js
var fetch2;
if (typeof process === "object" && process.release?.name === "node") {
  fetch2 = async function(url, options) {
    if (url.protocol === "file:") {
      const { readFile } = await import("node:fs/promises");
      const data = await readFile(url);
      const isWasm = url.pathname.endsWith(".wasm");
      const headers = {
        "content-length": data.length,
        "content-type": isWasm ? "application/wasm" : "application/octet-stream"
      };
      return new Response(data, { headers });
    } else {
      return globalThis.fetch(url, options);
    }
  };
} else {
  fetch2 = globalThis.fetch;
}
var fetch_default = fetch2;

// node_modules/@yowasp/runtime/lib/wasi-virt.js
var Exit = class extends Error {
  constructor(code = 0) {
    super(`Exited with status ${code}`);
    this.code = code;
  }
};
function monotonicNow() {
  return BigInt(Math.floor(performance.now() * 1e6));
}
function wallClockNow() {
  let now = Date.now();
  const seconds = BigInt(Math.floor(now / 1e3));
  const nanoseconds = now % 1e3 * 1e6;
  return { seconds, nanoseconds };
}
var Xoroshiro128StarStar = class {
  constructor(seed) {
    if (BigInt(seed) === 0n) {
      throw new Error("xoroshiro128** must be seeded with a non-zero state");
    }
    this.s = [BigInt(seed) & 0xffffffffffffffffn, BigInt(seed) >> 64n & 0xffffffffffffffffn];
  }
  next() {
    function trunc64(x) {
      return x & 0xffffffffffffffffn;
    }
    function rotl(x, k) {
      return x << k | x >> 64n - k;
    }
    let [s0, s1] = this.s;
    const r = trunc64(rotl(s0 * 5n, 7n) * 9n);
    s1 ^= s0;
    s0 = trunc64(rotl(s0, 24n) ^ s1 ^ s1 << 16n);
    s1 = trunc64(rotl(s1, 37n));
    this.s = [s0, s1];
    return r;
  }
  getBytes(length) {
    return Uint8Array.from({ length }, () => Number(BigInt.asUintN(8, this.next() >> 32n)));
  }
};
var Pollable = class {
  ready() {
    return true;
  }
  block() {
    return Promise.resolve();
  }
};
var IoError = class extends Error {
};
var InputStream = class {
  read(_len) {
    throw { tag: "closed" };
  }
  blockingRead(len) {
    return this.read(len);
  }
};
var OutputStream = class {
  checkWrite() {
    throw { tag: "closed" };
  }
  write(_contents) {
    this.checkWrite();
  }
  flush() {
  }
  blockingFlush() {
    this.flush();
  }
  blockingWriteAndFlush(contents) {
    this.write(contents);
    this.blockingFlush();
  }
};
var CallbackInputStream = class extends InputStream {
  constructor(callback = null) {
    super();
    this.callback = callback;
  }
  read(len) {
    if (this.callback === null)
      throw { tag: "closed" };
    let contents = this.callback(Number(len));
    if (contents === null)
      throw { tag: "closed" };
    return contents;
  }
};
var CallbackOutputStream = class extends OutputStream {
  constructor(callback = null) {
    super();
    this.callback = callback;
  }
  checkWrite() {
    return 4096;
  }
  write(contents) {
    if (this.callback !== null)
      this.callback(contents);
  }
  flush() {
    if (this.callback !== null)
      this.callback(null);
  }
};
var TerminalInput = class {
};
var TerminalOutput = class {
};
var nextFilesystemId = /* @__PURE__ */ (function() {
  let id = 0;
  return () => id++;
})();
var File = class {
  constructor(data = "") {
    this.id = nextFilesystemId();
    if (data instanceof Uint8Array) {
      this.data = data;
    } else if (typeof data === "string") {
      this.data = new TextEncoder().encode(data);
    } else {
      throw new Error(`Cannot construct a file from ${typeof data}`);
    }
  }
  get size() {
    return this.data.length;
  }
};
var Directory = class _Directory {
  constructor(files = {}) {
    this.id = nextFilesystemId();
    this.files = files;
  }
  get size() {
    return Object.keys(this.files).length;
  }
  traverse(path, { create = null, remove = false } = {}) {
    let entry = this;
    let separatorAt = -1;
    do {
      if (entry instanceof File)
        throw "not-directory";
      const files = entry.files;
      separatorAt = path.indexOf("/");
      const segment = separatorAt === -1 ? path : path.substring(0, separatorAt);
      if (separatorAt === -1 && remove)
        delete files[segment];
      else if (segment === "" || segment === ".")
        ;
      else if (segment === "..")
        ;
      else if (Object.hasOwn(files, segment))
        entry = files[segment];
      else if (create === "directory" || create !== null && separatorAt !== -1)
        entry = files[segment] = new _Directory({});
      else if (create === "file")
        entry = files[segment] = new File(new Uint8Array());
      else if (create instanceof File || create instanceof _Directory)
        entry = files[segment] = create;
      else
        throw "no-entry";
      path = path.substring(separatorAt + 1);
    } while (separatorAt !== -1);
    return entry;
  }
};
var ReadStream = class extends InputStream {
  constructor(file, offset) {
    super();
    this.file = file;
    this.offset = offset;
  }
  read(len) {
    const data = this.file.data.subarray(Number(this.offset), Number(this.offset + len));
    this.offset += len;
    return data;
  }
};
var WriteStream = class extends OutputStream {
  constructor(file, offset) {
    super();
    this.file = file;
    this.offset = offset;
  }
  write(contents) {
    const offset = Number(this.offset);
    const newData = new Uint8Array(Math.max(this.file.data.length, offset + contents.length));
    newData.set(this.file.data);
    newData.subarray(offset).set(contents);
    this.file.data = newData;
    this.offset += BigInt(contents.length);
  }
};
var Descriptor = class _Descriptor {
  constructor(entry) {
    this.entry = entry;
  }
  getType() {
    if (this.entry instanceof Directory)
      return "directory";
    if (this.entry instanceof File)
      return "regular-file";
  }
  getFlags() {
    return {};
  }
  metadataHash() {
    return { upper: 0, lower: this.entry.id };
  }
  metadataHashAt(_pathFlags, path) {
    if (!(this.entry instanceof Directory))
      throw "invalid";
    const pathEntry = this.entry.traverse(path);
    return new _Descriptor(pathEntry).metadataHash();
  }
  stat() {
    let type;
    if (this.entry instanceof Directory)
      type = "directory";
    if (this.entry instanceof File)
      type = "regular-file";
    return {
      type,
      linkCount: 1,
      size: this.entry.size,
      dataAccessTimestamp: null,
      dataModificationTimestamp: null,
      statusChangeTimestamp: null
    };
  }
  statAt(_pathFlags, path) {
    if (!(this.entry instanceof Directory))
      throw "invalid";
    const pathEntry = this.entry.traverse(path);
    return new _Descriptor(pathEntry).stat();
  }
  openAt(_pathFlags, path, openFlags, _descriptorFlags) {
    if (!(this.entry instanceof Directory))
      throw "invalid";
    const openEntry = this.entry.traverse(path, openFlags.create ? { create: "file" } : {});
    if (openFlags.directory) {
      if (!(openEntry instanceof Directory))
        throw "not-directory";
    } else {
      if (openEntry instanceof Directory)
        throw "is-directory";
      if (openFlags.truncate)
        openEntry.data = new Uint8Array();
    }
    return new _Descriptor(openEntry);
  }
  read(length, offset) {
    if (this.entry instanceof Directory)
      throw "is-directory";
    [length, offset] = [Number(length), Number(offset)];
    return [this.entry.data.subarray(offset, offset + length), offset + length >= this.entry.data.byteLength];
  }
  readViaStream(offset) {
    return new ReadStream(this.entry, offset);
  }
  write(_buffer, _offset) {
    if (this.entry instanceof Directory)
      throw "is-directory";
    console.error("Descriptor.write not implemented");
    throw "unsupported";
  }
  writeViaStream(offset) {
    return new WriteStream(this.entry, offset);
  }
  setSize(size) {
    if (this.entry instanceof Directory)
      throw "is-directory";
    size = Number(size);
    if (size > this.entry.data.length) {
      const newData = new Uint8Array(size);
      newData.set(this.entry.data);
      this.entry.data = newData;
    } else if (size < this.entry.data.length) {
      this.entry.data = this.entry.data.subarray(0, size);
    }
  }
  readDirectory() {
    return new DirectoryEntryStream(this.entry);
  }
  createDirectoryAt(path) {
    this.entry.traverse(path, { create: "directory" });
  }
  unlinkFileAt(path) {
    const pathEntry = this.entry.traverse(path);
    if (pathEntry instanceof Directory)
      throw "is-directory";
    this.entry.traverse(path, { remove: true });
  }
  removeDirectoryAt(path) {
    const pathEntry = this.entry.traverse(path);
    if (!(pathEntry instanceof Directory))
      throw "not-directory";
    this.entry.traverse(path, { remove: true });
  }
  readlinkAt(path) {
    const _pathEntry = this.entry.traverse(path);
    throw "invalid";
  }
  renameAt(oldPath, newDescriptor, newPath) {
    if (!(this.entry instanceof Directory))
      throw "not-directory";
    if (!(newDescriptor.entry instanceof Directory))
      throw "not-directory";
    const oldEntry = this.entry.traverse(oldPath);
    this.entry.traverse(newPath, { create: oldEntry });
    this.entry.traverse(oldPath, { remove: true });
  }
};
var DirectoryEntryStream = class {
  constructor(directory) {
    this.entries = Object.entries(directory.files);
    this.index = 0;
  }
  readDirectoryEntry() {
    if (this.index === this.entries.length)
      return null;
    const [name, entry] = this.entries[this.index++];
    let type;
    if (entry instanceof Directory)
      type = "directory";
    if (entry instanceof File)
      type = "regular-file";
    return { name, type };
  }
};
function directoryFromTree(tree) {
  const files = {};
  for (const [filename, data] of Object.entries(tree)) {
    if (typeof data === "string" || data instanceof Uint8Array)
      files[filename] = new File(tree[filename]);
    else
      files[filename] = directoryFromTree(tree[filename]);
  }
  return new Directory(files);
}
function directoryIntoTree(directory, { decodeASCII = true } = {}) {
  function isASCII(buffer) {
    for (const byte of buffer)
      if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 || byte >= 127)
        return false;
    return true;
  }
  const tree = {};
  for (const [filename, entry] of Object.entries(directory.files)) {
    if (entry instanceof File)
      tree[filename] = decodeASCII && isASCII(entry.data) ? new TextDecoder().decode(entry.data) : entry.data;
    if (entry instanceof Directory)
      tree[filename] = directoryIntoTree(entry, { decodeASCII });
  }
  return tree;
}
var Environment = class {
  vars = {};
  args = [];
  root = new Directory({});
  constructor() {
    this.prng = new Xoroshiro128StarStar(1n);
    this.standardInputStream = new CallbackInputStream();
    this.standardOutputStream = new CallbackOutputStream();
    this.standardErrorStream = new CallbackOutputStream();
    this.terminalInput = new TerminalInput();
    this.terminalOutput = new TerminalOutput();
    const $this = this;
    this.exports = {
      monotonicClock: {
        now: monotonicNow,
        subscribeDuration(time) {
          if (time !== 0n)
            throw new Error("unsupported");
          return new Pollable();
        },
        subscribeInstant() {
          throw new Error("unsupported");
        }
      },
      wallClock: {
        now: wallClockNow
      },
      random: {
        getRandomBytes(length) {
          return $this.prng.getBytes(Number(length));
        }
      },
      io: {
        Error: IoError,
        InputStream,
        OutputStream,
        Pollable,
        poll(list) {
          return Array.from(list, (p, i) => i);
        }
      },
      cli: {
        exit(status) {
          throw new Exit(status.tag === "ok" ? 0 : 1);
        },
        getEnvironment() {
          return $this.vars;
        },
        getArguments() {
          return $this.args;
        },
        getStdin() {
          return $this.standardInputStream;
        },
        getStdout() {
          return $this.standardOutputStream;
        },
        getStderr() {
          return $this.standardErrorStream;
        },
        getTerminalStdin() {
          return $this.terminalInput;
        },
        getTerminalStdout() {
          return $this.terminalOutput;
        },
        getTerminalStderr() {
          return $this.terminalOutput;
        },
        TerminalInput,
        TerminalOutput
      },
      fs: {
        Descriptor,
        DirectoryEntryStream,
        filesystemErrorCode() {
        },
        getDirectories() {
          if ($this.root === null) return [];
          return [[new Descriptor($this.root), "/"]];
        }
      }
    };
  }
  get stdin() {
    return this.standardInputStream.callback;
  }
  set stdin(callback) {
    this.standardInputStream.callback = callback;
  }
  get stdout() {
    return this.standardOutputStream.callback;
  }
  set stdout(callback) {
    this.standardOutputStream.callback = callback;
  }
  get stderr() {
    return this.standardErrorStream.callback;
  }
  set stderr(callback) {
    this.standardErrorStream.callback = callback;
  }
};

// node_modules/@yowasp/runtime/lib/util.js
function lineBuffered(processLine) {
  let buffer = new Uint8Array();
  return (bytes) => {
    if (bytes === null)
      return;
    let newBuffer = new Uint8Array(buffer.length + bytes.length);
    newBuffer.set(buffer);
    newBuffer.set(bytes, buffer.length);
    buffer = newBuffer;
    let newlineAt = -1;
    while (true) {
      const nextNewlineAt = buffer.indexOf(10, newlineAt + 1);
      if (nextNewlineAt === -1)
        break;
      processLine(new TextDecoder().decode(buffer.subarray(newlineAt + 1, nextNewlineAt)));
      newlineAt = nextNewlineAt;
    }
    buffer = buffer.subarray(newlineAt + 1);
  };
}

// node_modules/@yowasp/runtime/lib/api.js
var Application = class {
  #resourceModule;
  #resourceData;
  #instantiate;
  #argv0;
  constructor(resourceModule, instantiate2, argv0) {
    this.#resourceModule = resourceModule;
    this.#resourceData = null;
    this.#instantiate = instantiate2;
    this.#argv0 = argv0;
  }
  get argv0() {
    return this.#argv0;
  }
  async #fetchResources(fetchProgress) {
    const resourceModule = await this.#resourceModule;
    let fetchFn = fetch_default;
    if (fetchProgress !== void 0) {
      const status = { source: this, totalLength: resourceModule.totalSize, doneLength: 0 };
      fetchProgress(status);
      fetchFn = (input, init) => fetch_default(input, init).then((response) => {
        return new Response(response.body.pipeThrough(new TransformStream({
          transform(chunk, controller) {
            controller.enqueue(chunk);
            status.doneLength += chunk.length;
            fetchProgress(status);
          }
        })), response);
      });
    }
    const [modules2, filesystem2] = await Promise.all([
      resourceModule.modules(fetchFn),
      resourceModule.filesystem(fetchFn)
    ]);
    this.#resourceData = { modules: modules2, filesystem: filesystem2 };
  }
  // The `printLine` option is deprecated and not documented but still accepted for compatibility.
  run(args = null, files = {}, options = {}) {
    if (this.#resourceData === null) {
      if (options.synchronously)
        throw new Error("Cannot run application synchronously unless resources are prefetched first; use `await run()` to do so");
      const defaultFetchProgress = ({ source, totalLength, doneLength }) => {
        const percent = (100 * doneLength / totalLength).toFixed(0);
        console.log(`${source.argv0}: fetched ${percent}% (${doneLength} / ${totalLength})`);
      };
      return this.#fetchResources(options.fetchProgress ?? defaultFetchProgress).then(() => {
        return this.run(args, files, options);
      });
    }
    if (args === null)
      return;
    const environment = new Environment();
    environment.args = [this.#argv0].concat(args);
    environment.root = directoryFromTree(files);
    for (const [dirName, dirContents] of Object.entries(this.#resourceData.filesystem))
      environment.root.files[dirName] = directoryFromTree(dirContents);
    const lineBufferedConsole = lineBuffered(options.printLine ?? console.log);
    environment.stdin = options.stdin === void 0 ? null : options.stdin;
    environment.stdout = options.stdout === void 0 ? lineBufferedConsole : options.stdout;
    environment.stderr = options.stderr === void 0 ? lineBufferedConsole : options.stderr;
    const runCommand = (wasmCommand) => {
      let error = null;
      try {
        wasmCommand.run.run();
      } catch (e) {
        if (!(e instanceof Exit))
          throw e;
        if (e instanceof Exit && e.code !== 0)
          error = e;
      }
      for (const dirName of Object.keys(this.#resourceData.filesystem))
        delete environment.root.files[dirName];
      files = directoryIntoTree(environment.root, { decodeASCII: options.decodeASCII ?? true });
      if (error !== null) {
        error.files = files;
        throw error;
      } else {
        return files;
      }
    };
    const getCoreModule = (filename) => this.#resourceData.modules[filename];
    const imports = { runtime: environment.exports };
    if (options.synchronously) {
      const instantiateCore = (module, imports2) => new WebAssembly.Instance(module, imports2);
      return runCommand(this.#instantiate(getCoreModule, imports, instantiateCore));
    } else {
      return this.#instantiate(getCoreModule, imports).then(runCommand);
    }
  }
};

// gen/yosys-resources.js
var yosys_resources_exports = {};
__export(yosys_resources_exports, {
  filesystem: () => filesystem,
  modules: () => modules,
  totalSize: () => totalSize
});

// node_modules/nanotar/dist/index.mjs
var TAR_TYPE_FILE = 0;
var TAR_TYPE_DIR = 5;
function parseTar(data, opts) {
  const buffer = data.buffer || data;
  const files = [];
  let offset = 0;
  while (offset < buffer.byteLength - 512) {
    let name = _readString(buffer, offset, 100);
    if (name.length === 0) {
      break;
    }
    const mode = _readString(buffer, offset + 100, 8).trim();
    const uid = Number.parseInt(_readString(buffer, offset + 108, 8));
    const gid = Number.parseInt(_readString(buffer, offset + 116, 8));
    const size = _readNumber(buffer, offset + 124, 12);
    const seek = 512 + 512 * Math.trunc(size / 512) + (size % 512 ? 512 : 0);
    const mtime = _readNumber(buffer, offset + 136, 12);
    const _type = _readNumber(buffer, offset + 156, 1);
    const type = _type === TAR_TYPE_FILE ? "file" : _type === TAR_TYPE_DIR ? "directory" : _type;
    const user = _readString(buffer, offset + 265, 32);
    const group = _readString(buffer, offset + 297, 32);
    name = _sanitizePath(name);
    const meta = {
      name,
      type,
      size,
      attrs: {
        mode,
        uid,
        gid,
        mtime,
        user,
        group
      }
    };
    if (opts?.filter && !opts.filter(meta)) {
      offset += seek;
      continue;
    }
    if (opts?.metaOnly) {
      files.push(meta);
      offset += seek;
      continue;
    }
    const data2 = _type === TAR_TYPE_DIR ? void 0 : new Uint8Array(buffer, offset + 512, size);
    files.push({
      ...meta,
      data: data2,
      get text() {
        return new TextDecoder().decode(this.data);
      }
    });
    offset += seek;
  }
  return files;
}
function _sanitizePath(path) {
  let normalized = path.replace(/\\/g, "/");
  normalized = normalized.replace(/^[a-zA-Z]:\//, "");
  normalized = normalized.replace(/^\/+/, "");
  const hasLeadingDotSlash = normalized.startsWith("./");
  const parts = normalized.split("/");
  const resolved = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== "." && part !== "") {
      resolved.push(part);
    }
  }
  let result = resolved.join("/");
  if (hasLeadingDotSlash && !result.startsWith("./")) {
    result = "./" + result;
  }
  if (path.endsWith("/") && !result.endsWith("/")) {
    result += "/";
  }
  return result;
}
function _readString(buffer, offset, size) {
  const view = new Uint8Array(buffer, offset, size);
  const i = view.indexOf(0);
  const td = new TextDecoder();
  return td.decode(i === -1 ? view : view.slice(0, i));
}
function _readNumber(buffer, offset, size) {
  const view = new Uint8Array(buffer, offset, size);
  let str = "";
  for (let i = 0; i < size; i++) {
    str += String.fromCodePoint(view[i]);
  }
  return Number.parseInt(str, 8);
}

// gen/yosys-resources.js
function compileWasmModule(response) {
  if (WebAssembly.compileStreaming !== void 0) {
    return WebAssembly.compileStreaming(response);
  } else {
    return WebAssembly.compile(response.arrayBuffer());
  }
}
function unpackTarFilesystem(buffer) {
  const root = {};
  for (const tarEntry of parseTar(buffer)) {
    const nameParts = tarEntry.name.split("/");
    const dirNames = nameParts.slice(0, -1);
    const fileName = nameParts[nameParts.length - 1];
    let dir = root;
    for (const dirName of dirNames)
      dir = dir[dirName];
    if (tarEntry.type === "directory") {
      dir[fileName] = {};
    } else {
      dir[fileName] = tarEntry.data;
    }
  }
  return root;
}
var modules = async (fetch3) => ({
  "yosys.core.wasm": await fetch3(new URL("./yosys.core.wasm", import.meta.url)).then(compileWasmModule),
  "yosys.core2.wasm": await fetch3(new URL("./yosys.core2.wasm", import.meta.url)).then(compileWasmModule),
  "yosys.core3.wasm": await fetch3(new URL("./yosys.core3.wasm", import.meta.url)).then(compileWasmModule),
  "yosys.core4.wasm": await fetch3(new URL("./yosys.core4.wasm", import.meta.url)).then(compileWasmModule)
});
var filesystem = async (fetch3) => {
  var chunks = [];
  chunks.push(await fetch3(new URL("./yosys-resources.0.tar", import.meta.url)).then((resp) => resp.arrayBuffer()));
  return {
    "share": await new Blob(chunks).arrayBuffer().then(unpackTarFilesystem)
  };
};
var totalSize = 79174224;

// gen/yosys.js
function instantiate(getCoreModule, imports, instantiateCore, options) {
  const WebAssembly2 = options?.shim?.globals?.WebAssembly ?? globalThis.WebAssembly;
  if (typeof instantiateCore === "undefined") {
    if (typeof WebAssembly2 === "undefined") throw new Error("no WebAssembly implementation is available: pass instantiateCore or options.shim.globals.WebAssembly");
    instantiateCore = (module, importObject) => WebAssembly2.instantiate(module, importObject);
  }
  let dv = new DataView(new ArrayBuffer());
  const dataView = (mem) => dv.buffer === mem.buffer ? dv : dv = new DataView(mem.buffer);
  function toUint64(val) {
    const converted = BigInt(val);
    return BigInt.asUintN(64, converted);
  }
  function toUint32(val) {
    return val >>> 0;
  }
  function _isValidNumericPrimitive(ty, v) {
    if (v === void 0 || v === null) {
      return false;
    }
    switch (ty) {
      case "bool":
        return v === 0 || v === 1;
        break;
      case "u8":
        return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 255;
        break;
      case "s8":
        return typeof v === "number" && Number.isInteger(v) && v >= -128 && v <= 127;
        break;
      case "u16":
        return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 65535;
        break;
      case "s16":
        return typeof v === "number" && Number.isInteger(v) && v >= -32768 && v <= 32767;
      case "u32":
        return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4294967295;
      case "s32":
        return typeof v === "number" && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
      case "u64":
        return typeof v === "bigint" && v >= 0 && v <= 18446744073709551615n;
      case "s64":
        return typeof v === "bigint" && v >= -9223372036854775808n && v <= 9223372036854775807n;
        break;
      case "f32":
      case "f64":
        return typeof v === "number";
      default:
        return false;
    }
    return true;
  }
  function _requireValidNumericPrimitive(ty, v) {
    if (v === void 0 || v === null || !_isValidNumericPrimitive(ty, v)) {
      throw new TypeError(`invalid ${ty} value [${v}]`);
    }
    return true;
  }
  const utf16Decoder = new TextDecoder("utf-16", { fatal: true, ignoreBOM: true });
  const isLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  function _utf16AllocateAndEncode(str, realloc, memory) {
    if (typeof str !== "string") {
      throw new TypeError("expected a string, received [" + typeof str + "]");
    }
    const len = str.length;
    const ptr = realloc(0, 0, 2, len * 2);
    const out = new Uint16Array(memory.buffer, ptr, len);
    const put = isLE ? (i, ch) => {
      out[i] = ch;
    } : (i, ch) => {
      out[i] = (ch & 255) << 8 | ch >>> 8;
    };
    for (let i = 0; i < len; i++) {
      let ch = str.charCodeAt(i);
      if ((ch & 63488) === 55296) {
        if (ch < 56320 && i + 1 < len && (str.charCodeAt(i + 1) & 64512) === 56320) {
          put(i++, ch);
          ch = str.charCodeAt(i);
        } else {
          ch = 65533;
        }
      }
      put(i, ch);
    }
    return { ptr, len, codepoints: [...str].length };
  }
  const TEXT_DECODER_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const TEXT_ENCODER_UTF8 = new TextEncoder();
  function _utf8AllocateAndEncode(s, realloc, memory) {
    if (typeof s !== "string") {
      throw new TypeError("expected a string, received [" + typeof s + "]");
    }
    if (s.length === 0) {
      return { ptr: 1, len: 0 };
    }
    let len = 0;
    let codepoints = 0;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      codepoints++;
      if (ch < 128) {
        len += 1;
      } else if (ch < 2048) {
        len += 2;
      } else if (ch >= 55296 && ch <= 56319 && i + 1 < s.length && (s.charCodeAt(i + 1) & 64512) === 56320) {
        len += 4;
        i++;
      } else {
        len += 3;
      }
    }
    const ptr = realloc(0, 0, 1, len);
    const { read, written } = TEXT_ENCODER_UTF8.encodeInto(
      s,
      new Uint8Array(memory.buffer, ptr, len)
    );
    if (read !== s.length || written !== len) {
      throw new Error("failed to encode whole string");
    }
    const res = { ptr, len, codepoints };
    return res;
  }
  const T_FLAG = 1 << 30;
  const HANDLE_INDEX_SPACES = /* @__PURE__ */ new Map();
  function getHandleIndexSpace(key) {
    let space = HANDLE_INDEX_SPACES.get(key);
    if (space === void 0) {
      space = {
        next: 1,
        free: [],
        alloc() {
          return this.free.length > 0 ? this.free.pop() : this.next++;
        },
        release(idx) {
          this.free.push(idx);
        }
      };
      HANDLE_INDEX_SPACES.set(key, space);
    }
    return space;
  }
  function rscTableCreateOwn(table, rep2) {
    table._createdReps.add(rep2);
    const handle = getHandleIndexSpace(table._componentIdx ?? table).alloc();
    table[handle << 1] = 0;
    table[(handle << 1) + 1] = rep2 | T_FLAG;
    return handle;
  }
  const RESOURCE_SCOPE_TASKS = /* @__PURE__ */ new Map();
  const WebAssemblyRuntimeError = WebAssembly2.RuntimeError;
  function rscTableRemove(table, handle) {
    const scope = table[handle << 1];
    const val = table[(handle << 1) + 1];
    const own = (val & T_FLAG) !== 0;
    const rep2 = val & ~T_FLAG;
    if (val === void 0 || val === 0 || (scope & T_FLAG) !== 0) {
      throw new WebAssemblyRuntimeError(`unknown handle index ${handle}`);
    }
    if (own && scope !== 0) {
      throw new WebAssemblyRuntimeError("cannot remove owned resource while borrowed");
    }
    const borrowTask = own ? void 0 : RESOURCE_SCOPE_TASKS.get(scope);
    table[handle << 1] = T_FLAG;
    table[(handle << 1) + 1] = 0;
    getHandleIndexSpace(table._componentIdx ?? table).release(handle);
    borrowTask?.removeBorrowedHandle();
    return { rep: rep2, scope, own };
  }
  let RESOURCE_SCOPE_ID = 0;
  let curResourceBorrows = [];
  const ASYNC_TASKS_BY_COMPONENT_IDX = /* @__PURE__ */ new Map();
  const ASYNC_CURRENT_COMPONENT_IDXS = [];
  const CURRENT_TASK_META = {};
  function getCurrentTask(componentIdx2, taskID) {
    let usedGlobal = false;
    if (componentIdx2 === void 0 || componentIdx2 === null) {
      throw new Error("missing component idx");
    }
    const taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx2);
    if (taskMetas === void 0 || taskMetas.length === 0) {
      return void 0;
    }
    if (taskID) {
      return taskMetas.find((meta) => meta.task.id() === taskID);
    }
    const current = CURRENT_TASK_META[componentIdx2];
    if (current && current.taskID !== void 0) {
      const currentMeta = taskMetas.find((meta) => meta.task.id() === current.taskID);
      if (currentMeta) {
        return currentMeta;
      }
    }
    const taskMeta = taskMetas[taskMetas.length - 1];
    if (!taskMeta || !taskMeta.task) {
      return void 0;
    }
    return taskMeta;
  }
  const ASYNC_CURRENT_TASK_IDS = [];
  const _debugLog = (...args) => {
    if (!globalThis?.process?.env?.JCO_DEBUG) {
      return;
    }
    console.debug(...args);
  };
  function clearCurrentTask(componentIdx2, taskID) {
    _debugLog("[clearCurrentTask()] args", { componentIdx: componentIdx2, taskID });
    if (componentIdx2 === void 0 || componentIdx2 === null) {
      throw new Error("missing/invalid component instance index while ending current task");
    }
    const tasks = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx2);
    if (!tasks || !Array.isArray(tasks)) {
      throw new Error("missing/invalid tasks for component instance while ending task");
    }
    if (tasks.length == 0) {
      throw new Error(`no current tasks for component instance [${componentIdx2}] while ending task`);
    }
    const taskIdx = taskID === void 0 ? tasks.length - 1 : tasks.findIndex((meta) => meta.id === taskID);
    if (taskIdx === -1) {
      return;
    }
    const taskMeta = tasks.splice(taskIdx, 1)[0];
    const globalTaskIdx = ASYNC_CURRENT_TASK_IDS.lastIndexOf(taskMeta.id);
    if (globalTaskIdx !== -1) {
      ASYNC_CURRENT_TASK_IDS.splice(globalTaskIdx, 1);
      ASYNC_CURRENT_COMPONENT_IDXS.splice(globalTaskIdx, 1);
    }
    return taskMeta.task;
  }
  const ASYNC_STATE = /* @__PURE__ */ new Map();
  function promiseWithResolvers() {
    if (Promise.withResolvers) {
      return Promise.withResolvers();
    } else {
      let resolve2;
      let reject2;
      const promise2 = new Promise((res, rej) => {
        resolve2 = res;
        reject2 = rej;
      });
      return { promise: promise2, resolve: resolve2, reject: reject2 };
    }
  }
  class Waitable {
    #componentIdx;
    #pendingEventFn = null;
    #promise;
    #resolve;
    #reject;
    #waitableSet = null;
    #hasSyncWaiter = false;
    #idx = null;
    // to component-global waitables
    target;
    constructor(args) {
      const { componentIdx: componentIdx2, target } = args;
      this.#componentIdx = componentIdx2;
      this.target = args.target;
      this.#resetPromise();
    }
    componentIdx() {
      return this.#componentIdx;
    }
    isInSet() {
      return this.#waitableSet !== null;
    }
    idx() {
      return this.#idx;
    }
    setIdx(idx) {
      if (idx === 0) {
        throw new Error("waitable idx cannot be zero");
      }
      this.#idx = idx;
    }
    setTarget(tgt) {
      this.target = tgt;
    }
    #resetPromise() {
      const { promise: promise2, resolve: resolve2, reject: reject2 } = promiseWithResolvers();
      this.#promise = promise2;
      this.#resolve = resolve2;
      this.#reject = reject2;
    }
    resolve() {
      this.#resolve();
    }
    reject(err) {
      this.#reject(err);
    }
    promise() {
      return this.#promise;
    }
    hasPendingEvent() {
      return this.#pendingEventFn !== null;
    }
    setPendingEvent(fn) {
      _debugLog("[Waitable#setPendingEvent()] args", {
        waitable: this,
        inSet: this.#waitableSet
      });
      this.#pendingEventFn = fn;
    }
    getPendingEvent() {
      _debugLog("[Waitable#getPendingEvent()] args", {
        waitable: this,
        inSet: this.#waitableSet,
        hasPendingEvent: this.#pendingEventFn !== null
      });
      if (this.#pendingEventFn === null) {
        return null;
      }
      const eventFn = this.#pendingEventFn;
      this.#pendingEventFn = null;
      const e = eventFn();
      this.#resetPromise();
      return e;
    }
    join(waitableSet) {
      _debugLog("[Waitable#join()] args", {
        waitable: this,
        waitableSet,
        isRemoval: waitableSet === null
      });
      if (this.#waitableSet === void 0) {
        throw new TypeError("waitable set must be not be undefined");
      }
      if (this.#waitableSet) {
        this.#waitableSet.removeWaitable(this);
      }
      this.#waitableSet = waitableSet;
      if (waitableSet) {
        this.#waitableSet.addWaitable(this);
      }
    }
    drop() {
      _debugLog("[Waitable#drop()] args", {
        componentIdx: this.#componentIdx,
        waitable: this
      });
      this.join(null);
    }
    async waitForPendingEvent(args) {
      const { cstate } = args;
      if (!cstate) {
        throw new TypeError("missing component state");
      }
      if (this.#waitableSet !== null || this.#hasSyncWaiter) {
        throw new Error("waitable is already in a set/has a sync waiter");
      }
      this.#hasSyncWaiter = true;
      await cstate.waitUntil({
        cancellable: false,
        readyFn: () => this.hasPendingEvent()
      });
      this.#hasSyncWaiter = false;
    }
  }
  const INSTANCE_FLAGS = /* @__PURE__ */ new Map();
  const STORE_TRAP = { error: null };
  const STORE_ASYNC_STATE = { deadlockCheck: null, pendingHostOperations: 0 };
  function _checkForDeadlock() {
    if (STORE_ASYNC_STATE.deadlockCheck !== null || STORE_TRAP.error !== null) {
      return;
    }
    STORE_ASYNC_STATE.deadlockCheck = setTimeout(() => {
      STORE_ASYNC_STATE.deadlockCheck = null;
      if (STORE_TRAP.error !== null || STORE_ASYNC_STATE.pendingHostOperations > 0) {
        return;
      }
      const suspendedTasks = /* @__PURE__ */ new Set();
      for (const state of ASYNC_STATE.values()) {
        if (state.hasPendingSchedulerWork()) {
          state.runTickLoop();
          return;
        }
        for (const meta of state.suspendedTaskMetas()) {
          suspendedTasks.add(meta.task);
        }
      }
      const unresolvedRoots = /* @__PURE__ */ new Set();
      for (const task of suspendedTasks) {
        const root = task.getRootTask();
        if (!root.isResolvedState()) {
          unresolvedRoots.add(root);
        }
      }
      if (unresolvedRoots.size === 0) {
        return;
      }
      const err = new WebAssemblyRuntimeError("wasm trap: deadlock detected: event loop cannot make further progress");
      err.deadlockDetail = {
        pendingHostOperations: STORE_ASYNC_STATE.pendingHostOperations,
        suspendedTasks: [...suspendedTasks].map((task) => ({
          taskID: task.id(),
          componentIdx: task.componentIdx(),
          state: task.taskState(),
          rootTaskID: task.getRootTask().id()
        })),
        unresolvedRootTaskIDs: [...unresolvedRoots].map((root) => root.id())
      };
      STORE_TRAP.error = err;
      for (const root of unresolvedRoots) {
        root.setErrored(err);
        root.reject(err);
      }
      for (const task of suspendedTasks) {
        if (!task.isResolvedState() && unresolvedRoots.has(task.getRootTask())) {
          task.setErrored(err);
          task.reject(err);
        }
      }
      for (const state of ASYNC_STATE.values()) {
        state.markTrapped(err);
      }
      for (const state of ASYNC_STATE.values()) {
        state.abandonLockWaiters();
      }
      for (const state of ASYNC_STATE.values()) {
        state.abandonAdmissionWaiters();
      }
      for (const state of ASYNC_STATE.values()) {
        state.runTickLoop();
      }
    }, 0);
  }
  const CORE_TRAP_MESSAGES = /* @__PURE__ */ new Map([
    ["unreachable", "wasm trap: wasm `unreachable` instruction executed"],
    ["memory access out of bounds", "wasm trap: out of bounds memory access"],
    ["divide by zero", "wasm trap: integer divide by zero"],
    ["remainder by zero", "wasm trap: integer divide by zero"],
    ["divide result unrepresentable", "wasm trap: integer overflow"],
    ["float unrepresentable in integer range", "wasm trap: invalid conversion to integer"],
    ["table index is out of bounds", "wasm trap: undefined element: out of bounds table access"],
    ["function signature mismatch", "wasm trap: indirect call type mismatch"],
    ["call stack exhausted", "wasm trap: call stack exhausted"]
  ]);
  function _normalizeCoreTrap(err) {
    if (!(err instanceof WebAssemblyRuntimeError)) {
      return err;
    }
    const message = CORE_TRAP_MESSAGES.get(err.message);
    if (message !== void 0) {
      err.message = message;
    }
    return err;
  }
  class RepTable {
    // Sentinel marking a freed slot; the freelist link for a freed slot
    // lives in the odd cell. This keeps get()/contains()/remove() on freed
    // reps well-defined (previously they returned/corrupted freelist links).
    static FREE = Symbol("RepTable.free");
    #data = [0, null];
    #size = 0;
    #target;
    // An index space shared with the other handle kinds of a component
    // instance (see `getHandleIndexSpace`); without one, this table keeps
    // its own free list.
    #space = null;
    constructor(args) {
      this.target = args?.target;
      this.#space = args?.space ?? null;
    }
    data() {
      return this.#data;
    }
    insert(val) {
      if (this.#space !== null) {
        const rep2 = this.#space.alloc();
        this.#data[rep2 << 1] = val;
        this.#data[(rep2 << 1) + 1] = null;
        this.#size += 1;
        return rep2;
      }
      _debugLog("[RepTable#insert()] args", { val, target: this.target });
      const freeIdx = this.#data[0];
      if (freeIdx === 0) {
        this.#data.push(val);
        this.#data.push(null);
        const rep2 = (this.#data.length >> 1) - 1;
        _debugLog("[RepTable#insert()] inserted", { val, target: this.target, rep: rep2 });
        this.#size += 1;
        return rep2;
      }
      const placementIdx = freeIdx << 1;
      if (this.#data[placementIdx] !== RepTable.FREE) {
        throw new Error("corrupt rep table freelist: head does not point at a freed slot");
      }
      this.#data[0] = this.#data[placementIdx + 1];
      this.#data[placementIdx] = val;
      this.#data[placementIdx + 1] = null;
      _debugLog("[RepTable#insert()] inserted", { val, target: this.target, rep: freeIdx });
      this.#size += 1;
      return freeIdx;
    }
    get(rep2) {
      _debugLog("[RepTable#get()] args", { rep: rep2, target: this.target });
      if (rep2 === 0) {
        throw new WebAssemblyRuntimeError("invalid resource rep during get, (cannot be 0)");
      }
      const baseIdx = rep2 << 1;
      const val = this.#data[baseIdx];
      if (val === RepTable.FREE) {
        return void 0;
      }
      return val;
    }
    contains(rep2) {
      _debugLog("[RepTable#contains()] args", { rep: rep2, target: this.target });
      if (rep2 === 0) {
        throw new Error("invalid resource rep during contains, (cannot be 0)");
      }
      const baseIdx = rep2 << 1;
      const val = this.#data[baseIdx];
      return val !== RepTable.FREE && !!val;
    }
    remove(rep2) {
      _debugLog("[RepTable#remove()] args", { rep: rep2, target: this.target });
      if (rep2 === 0) {
        throw new Error("invalid resource rep during remove, (cannot be 0)");
      }
      if (this.#space !== null) {
        const baseIdx2 = rep2 << 1;
        const val2 = this.#data[baseIdx2];
        if (val2 === void 0 || val2 === RepTable.FREE) {
          throw new WebAssemblyRuntimeError(`unknown handle index ${rep2}`);
        }
        this.#data[baseIdx2] = RepTable.FREE;
        this.#data[baseIdx2 + 1] = null;
        this.#size -= 1;
        this.#space.release(rep2);
        return val2;
      }
      if (this.#data.length === 2) {
        throw new Error("invalid");
      }
      const baseIdx = rep2 << 1;
      if (baseIdx >= this.#data.length) {
        throw new Error(`invalid rep [${rep2}] during remove, out of range`);
      }
      const val = this.#data[baseIdx];
      if (val === RepTable.FREE) {
        throw new WebAssemblyRuntimeError(`double removal of rep [${rep2}] (already freed)`);
      }
      this.#data[baseIdx] = RepTable.FREE;
      this.#data[baseIdx + 1] = this.#data[0];
      this.#data[0] = rep2;
      this.#size -= 1;
      return val;
    }
    size() {
      return this.#size;
    }
    clear() {
      _debugLog("[RepTable#clear()] args", { rep, target: this.target });
      this.#data = [0, null];
    }
  }
  class ComponentAsyncState {
    static EVENT_HANDLER_EVENTS = ["backpressure-change"];
    static TickResult = {
      // no suspended tasks remain
      DONE: "done",
      // a suspended task was resumed (more may be ready)
      RESUMED: "resumed",
      // suspended tasks remain but none were ready
      IDLE: "idle"
    };
    #componentIdx;
    #callingAsyncImport = false;
    #syncImportWait = promiseWithResolvers();
    #lockHolderTaskID = null;
    #lockWaiters = [];
    #admissionQueue = [];
    #lockHandoffScheduled = false;
    #pendingTaskStarts = 0;
    #parkedTasks = /* @__PURE__ */ new Map();
    #suspendedTasksByTaskID = /* @__PURE__ */ new Map();
    #suspendedTaskIDs = [];
    #errored = null;
    #trapped = false;
    #trapError = null;
    #backpressure = 0;
    #backpressureWaiters = 0n;
    #handlerMap = /* @__PURE__ */ new Map();
    #nextHandlerID = 0n;
    #tickLoop = null;
    #tickLoopInterval = null;
    #onExclusiveReleaseHandlers = [];
    #mayLeave = true;
    handles;
    subtasks;
    constructor(args) {
      this.#componentIdx = args.componentIdx;
      this.handles = new RepTable({
        target: `component [${this.#componentIdx}] handles (waitable objects)`,
        space: getHandleIndexSpace(this.#componentIdx)
      });
      this.subtasks = new RepTable({ target: `component [${this.#componentIdx}] subtasks` });
    }
    componentIdx() {
      return this.#componentIdx;
    }
    get mayLeave() {
      const flags = INSTANCE_FLAGS.get(this.#componentIdx);
      return flags === void 0 ? this.#mayLeave : flags.value === 1;
    }
    set mayLeave(value) {
      if (typeof value !== "boolean") {
        throw new TypeError("mayLeave must be a boolean");
      }
      this.#mayLeave = value;
      const flags = INSTANCE_FLAGS.get(this.#componentIdx);
      if (flags !== void 0) {
        flags.value = value ? 1 : 0;
      }
    }
    errored() {
      return this.#errored !== null;
    }
    setErrored(err) {
      _debugLog("[ComponentAsyncState#setErrored()] component errored", { err, componentIdx: this.#componentIdx });
      if (this.#errored) {
        return;
      }
      if (!err) {
        err = new Error("error elswehere (see other component instance error)");
        err.componentIdx = this.#componentIdx;
      }
      this.#errored = err;
    }
    markTrapped(err) {
      if (!(err instanceof WebAssemblyRuntimeError)) {
        return false;
      }
      err = _normalizeCoreTrap(err);
      this.#trapped = true;
      if (this.#trapError === null) {
        this.#trapError = err;
      }
      _debugLog("[ComponentAsyncState#markTrapped()] component trapped", { err, componentIdx: this.#componentIdx });
      if (STORE_TRAP.error === null) {
        STORE_TRAP.error = err;
      }
      return true;
    }
    isTrapped() {
      return this.#trapped;
    }
    // For work that was already under way or queued when the instance
    // trapped: it fails with that trap (nothing runs after a trap).
    throwIfInterrupted() {
      if (this.#trapped) {
        throw this.#trapError ?? new WebAssemblyRuntimeError("wasm trap: cannot enter component instance");
      }
    }
    throwIfTrapped() {
      if (this.#trapped) {
        throw new WebAssemblyRuntimeError("wasm trap: cannot enter component instance");
      }
    }
    callingSyncImport(val) {
      if (val === void 0) {
        return this.#callingAsyncImport;
      }
      if (typeof val !== "boolean") {
        throw new TypeError("invalid setting for async import");
      }
      const prev = this.#callingAsyncImport;
      this.#callingAsyncImport = val;
      if (prev === true && this.#callingAsyncImport === false) {
        this.#notifySyncImportEnd();
      }
    }
    #notifySyncImportEnd() {
      const existing = this.#syncImportWait;
      this.#syncImportWait = promiseWithResolvers();
      existing.resolve();
    }
    async waitForSyncImportCallEnd() {
      await this.#syncImportWait.promise;
    }
    setBackpressure(v) {
      this.#backpressure = v;
      return this.#backpressure;
    }
    getBackpressure() {
      return this.#backpressure;
    }
    incrementBackpressure() {
      const current = this.#backpressure;
      if (current < 0 || current > 2 ** 16) {
        throw new Error(`invalid current backpressure value [${current}]`);
      }
      const newValue = this.getBackpressure() + 1;
      if (newValue >= 2 ** 16) {
        throw new Error(`invalid new backpressure value [${newValue}], overflow`);
      }
      return this.setBackpressure(newValue);
    }
    decrementBackpressure() {
      const current = this.#backpressure;
      if (current < 0 || current > 2 ** 16) {
        throw new Error(`invalid current backpressure value [${current}]`);
      }
      const newValue = current - 1;
      if (newValue < 0) {
        throw new WebAssemblyRuntimeError("backpressure counter underflow");
      }
      return this.setBackpressure(newValue);
    }
    hasBackpressure() {
      return this.#backpressure > 0;
    }
    waitForBackpressure() {
      let backpressureCleared = false;
      const cstate = this;
      cstate.addBackpressureWaiter();
      const handlerID = this.registerHandler({
        event: "backpressure-change",
        fn: (bp) => {
          if (bp === 0) {
            cstate.removeHandler(handlerID);
            backpressureCleared = true;
          }
        }
      });
      return new Promise((resolve2) => {
        const interval = setInterval(() => {
          if (backpressureCleared) {
            return;
          }
          clearInterval(interval);
          cstate.removeBackpressureWaiter();
          resolve2(null);
        }, 0);
      });
    }
    registerHandler(args) {
      const { event, fn } = args;
      if (!event) {
        throw new Error("missing handler event");
      }
      if (!fn) {
        throw new Error("missing handler fn");
      }
      if (!ComponentAsyncState.EVENT_HANDLER_EVENTS.includes(event)) {
        throw new Error(`unrecognized event handler [${event}]`);
      }
      const handlerID = this.#nextHandlerID++;
      let handlers = this.#handlerMap.get(event);
      if (!handlers) {
        handlers = [];
        this.#handlerMap.set(event, handlers);
      }
      handlers.push({ id: handlerID, fn, event });
      return handlerID;
    }
    removeHandler(args) {
      const { event, handlerID } = args;
      const registeredHandlers = this.#handlerMap.get(event);
      if (!registeredHandlers) {
        return;
      }
      const found = registeredHandlers.find((h) => h.id === handlerID);
      if (!found) {
        return;
      }
      this.#handlerMap.set(event, this.#handlerMap.get(event).filter((h) => h.id !== handlerID));
    }
    getBackpressureWaiters() {
      return this.#backpressureWaiters;
    }
    addBackpressureWaiter() {
      this.#backpressureWaiters++;
    }
    removeBackpressureWaiter() {
      this.#backpressureWaiters--;
      if (this.#backpressureWaiters < 0) {
        throw new Error("unexepctedly negative number of backpressure waiters");
      }
    }
    // The per-slice mutual-exclusion lock for guest execution in this
    // component instance. Guest slices (callback invocations and
    // sync-lifted bodies) must be atomic per component even across the
    // JSPI suspensions jco introduces for host imports: wit-bindgen's
    // executors publish per-task state in single linear-memory cells
    // (the wasip3-task pointer, context-local storage discipline) that
    // an interleaved slice of the same component corrupts
    //
    // The lock is *owned*: acquisition records the holder task and
    // release is a no-op for anyone else, so a task exiting can no
    // longer drop a hold it does not own (blind acquire/release-any
    // was the previous discipline). Contended acquisition queues
    // FIFO; release hands the lock to the next waiter directly.
    isExclusivelyLocked() {
      return this.#lockHolderTaskID !== null;
    }
    exclusivelyLockedBy(taskID) {
      return this.#lockHolderTaskID === taskID;
    }
    exclusiveLock(taskID) {
      _debugLog("[ComponentAsyncState#exclusiveLock()]", {
        holder: this.#lockHolderTaskID,
        requester: taskID,
        componentIdx: this.#componentIdx
      });
      if (taskID === void 0 || taskID === null) {
        throw new Error("exclusive lock requires the acquiring task id");
      }
      if (this.#lockHolderTaskID !== null) {
        throw new Error(`component [${this.#componentIdx}] exclusive lock held by task [${this.#lockHolderTaskID}], requested by [${taskID}]`);
      }
      this.#lockHolderTaskID = taskID;
    }
    // Awaitable acquisition: takes the lock immediately when free,
    // otherwise queues FIFO behind the current holder and earlier
    // waiters. The resolved promise implies ownership.
    acquireExclusiveLock(taskID) {
      if (taskID === void 0 || taskID === null) {
        throw new Error("exclusive lock requires the acquiring task id");
      }
      if (this.#lockHolderTaskID === null) {
        this.#lockHolderTaskID = taskID;
        _debugLog("[ComponentAsyncState#acquireExclusiveLock()] acquired", {
          holder: taskID,
          componentIdx: this.#componentIdx
        });
        return;
      }
      if (this.#lockHolderTaskID === taskID) {
        throw new Error(`task [${taskID}] already holds the lock for component [${this.#componentIdx}]`);
      }
      _debugLog("[ComponentAsyncState#acquireExclusiveLock()] waiting", {
        holder: this.#lockHolderTaskID,
        requester: taskID,
        componentIdx: this.#componentIdx,
        queued: this.#lockWaiters.length
      });
      return new Promise((resolve2) => {
        this.#lockWaiters.push({ taskID, resolve: resolve2 });
      });
    }
    // Release every queued entry without granting ownership, so that
    // calls waiting to enter a trapped store fail instead of hanging.
    // FIFO admission of tasks entering this instance (Canonical ABI
    // `inst.pending`): a task enters only after every task that asked to
    // enter before it has entered or given up, so calls enter in the order
    // they were made, whatever each waits for on the way.
    takeAdmissionTicket(taskID) {
      const ticket = { taskID, ...promiseWithResolvers() };
      this.#admissionQueue.push(ticket);
      return ticket;
    }
    hasPendingAdmissions() {
      return this.#admissionQueue.length > 0;
    }
    waitForAdmissionTurn(ticket) {
      if (this.#admissionQueue[0] === ticket) {
        return;
      }
      return ticket.promise;
    }
    releaseAdmissionTicket(ticket) {
      const idx = this.#admissionQueue.indexOf(ticket);
      if (idx === -1) {
        return;
      }
      this.#admissionQueue.splice(idx, 1);
      if (idx === 0 && this.#admissionQueue.length > 0) {
        this.#admissionQueue[0].resolve();
      }
    }
    // Release every queued entry (the instance trapped): each then fails
    // in `enter()` instead of waiting forever.
    abandonAdmissionWaiters() {
      const tickets = this.#admissionQueue.splice(0);
      for (const ticket of tickets) {
        ticket.resolve();
      }
    }
    abandonLockWaiters() {
      const waiters = this.#lockWaiters.splice(0);
      for (const waiter of waiters) {
        waiter.resolve();
      }
    }
    cancelExclusiveLockWaiter(taskID) {
      const idx = this.#lockWaiters.findIndex((waiter2) => waiter2.taskID === taskID);
      if (idx === -1) {
        return false;
      }
      const [waiter] = this.#lockWaiters.splice(idx, 1);
      waiter.resolve();
      return true;
    }
    exclusiveRelease(taskID) {
      _debugLog("[ComponentAsyncState#exclusiveRelease()] args", {
        holder: this.#lockHolderTaskID,
        releaser: taskID,
        componentIdx: this.#componentIdx
      });
      if (this.#lockHolderTaskID !== taskID) {
        _debugLog("[ComponentAsyncState#exclusiveRelease()] ignoring foreign release", {
          holder: this.#lockHolderTaskID,
          releaser: taskID,
          componentIdx: this.#componentIdx
        });
        return false;
      }
      this.#lockHolderTaskID = null;
      this.#onExclusiveReleaseHandlers = this.#onExclusiveReleaseHandlers.filter((v) => !!v);
      for (const [idx, f] of this.#onExclusiveReleaseHandlers.entries()) {
        try {
          this.#onExclusiveReleaseHandlers[idx] = null;
          f();
        } catch (err) {
          _debugLog("error while executing handler for next exclusive release", err);
          throw err;
        }
      }
      this.#scheduleLockHandoff();
      return true;
    }
    #scheduleLockHandoff() {
      if (this.#lockHandoffScheduled || this.#lockWaiters.length === 0) {
        return;
      }
      this.#lockHandoffScheduled = true;
      queueMicrotask(() => {
        this.#lockHandoffScheduled = false;
        if (this.#lockHolderTaskID !== null) {
          return;
        }
        const next = this.#lockWaiters.shift();
        if (!next) {
          return;
        }
        this.#lockHolderTaskID = next.taskID;
        next.resolve();
      });
    }
    onNextExclusiveRelease(fn) {
      _debugLog("[ComponentAsyncState#()onNextExclusiveRelease] registering");
      this.#onExclusiveReleaseHandlers.push(fn);
    }
    async waitForExclusiveRelease() {
      while (this.isExclusivelyLocked()) {
        await new Promise((resolve2) => this.onNextExclusiveRelease(resolve2));
      }
    }
    #getSuspendedTaskMeta(taskID) {
      return this.#suspendedTasksByTaskID.get(taskID);
    }
    #removeSuspendedTaskMeta(taskID) {
      _debugLog("[ComponentAsyncState#removeSuspendedTaskMeta()] removing suspended task", {
        taskID,
        componentIdx: this.#componentIdx
      });
      const idx = this.#suspendedTaskIDs.findIndex((t) => t === taskID);
      const meta = this.#suspendedTasksByTaskID.get(taskID);
      this.#suspendedTaskIDs[idx] = null;
      this.#suspendedTasksByTaskID.delete(taskID);
      return meta;
    }
    #addSuspendedTaskMeta(meta) {
      if (!meta) {
        throw new Error("missing task meta");
      }
      const taskID = meta.taskID;
      this.#suspendedTasksByTaskID.set(taskID, meta);
      this.#suspendedTaskIDs.push(taskID);
      if (this.#suspendedTasksByTaskID.size < this.#suspendedTaskIDs.length - 10) {
        this.#suspendedTaskIDs = this.#suspendedTaskIDs.filter((t) => t !== null);
      }
    }
    // TODO(threads): readyFn is normally on the thread
    suspendTask(args) {
      const { task, readyFn, cancellable, onResume } = args;
      const taskID = task.id();
      const componentIdx2 = task.componentIdx();
      task.endFirstSlice();
      _debugLog("[ComponentAsyncState#suspendTask()]", {
        taskID,
        componentIdx: this.#componentIdx,
        taskEntryFnName: task.entryFnName(),
        subtask: task.getParentSubtask()
      });
      if (componentIdx2 !== this.#componentIdx) {
        throw new Error("assert: task component idx should match async state");
      }
      if (this.#getSuspendedTaskMeta(taskID)) {
        throw new Error(`task [${taskID}] already suspended`);
      }
      let promise2;
      let resume;
      if (onResume) {
        resume = () => onResume(!task.isCancelled());
      } else {
        const resolvers = promiseWithResolvers();
        promise2 = resolvers.promise;
        resume = () => resolvers.resolve(!task.isCancelled());
      }
      this.#addSuspendedTaskMeta({
        task,
        taskID,
        cancellable,
        readyFn,
        resume: () => {
          _debugLog("[ComponentAsyncState] resuming suspended task", {
            taskID,
            componentIdx: this.#componentIdx
          });
          resume();
        }
      });
      task.notifyProgress();
      this.runTickLoop();
      _checkForDeadlock();
      return promise2;
    }
    resumeTaskByID(taskID) {
      const meta = this.#removeSuspendedTaskMeta(taskID);
      if (!meta) {
        return false;
      }
      if (meta.taskID !== taskID) {
        throw new Error("task ID does not match");
      }
      meta.resume();
      return true;
    }
    suspendedTaskReady(taskID) {
      const meta = this.#getSuspendedTaskMeta(taskID);
      if (!meta) {
        return false;
      }
      if (!meta.readyFn) {
        throw new Error(`suspended task [${taskID}] is missing a readiness function`);
      }
      if (meta.task.isRejected()) {
        return true;
      }
      if (!meta.readyFn()) {
        return false;
      }
      return !meta.task.needsExclusiveLock() || !this.isExclusivelyLocked() || this.exclusivelyLockedBy(taskID);
    }
    suspendedTaskCancellable(taskID) {
      return !!this.#getSuspendedTaskMeta(taskID)?.cancellable;
    }
    isTaskSuspended(taskID) {
      return this.#suspendedTasksByTaskID.has(taskID);
    }
    suspendedTaskMetas() {
      return this.#suspendedTasksByTaskID.values();
    }
    addPendingTaskStart() {
      this.#pendingTaskStarts++;
    }
    removePendingTaskStart() {
      this.#pendingTaskStarts--;
    }
    hasPendingSchedulerWork() {
      if (this.#pendingTaskStarts > 0) {
        return true;
      }
      if (this.#lockHandoffScheduled) {
        return true;
      }
      for (const meta of this.#suspendedTasksByTaskID.values()) {
        if (meta.task.isRejected() || meta.readyFn()) {
          return true;
        }
      }
      return false;
    }
    async runTickLoop() {
      if (this.#tickLoop !== null) {
        return;
      }
      this.#tickLoop = 1;
      setTimeout(async () => {
        let result = this.tick();
        while (result !== ComponentAsyncState.TickResult.DONE) {
          if (result === ComponentAsyncState.TickResult.IDLE) {
            _checkForDeadlock();
          }
          const delay = result === ComponentAsyncState.TickResult.RESUMED ? 0 : 10;
          await new Promise((resolve2) => setTimeout(resolve2, delay));
          result = this.tick();
        }
        this.#tickLoop = null;
      }, 10);
    }
    tick() {
      const resumableTasks = this.#suspendedTaskIDs.filter((t) => t !== null);
      for (const taskID of resumableTasks) {
        const meta = this.#suspendedTasksByTaskID.get(taskID);
        if (!meta || !meta.readyFn) {
          throw new Error(`missing/invalid task despite ID [${taskID}] being present`);
        }
        if (meta.task.isRejected()) {
          _debugLog("[ComponentAsyncState#tick()] detected task rejection, leaving early", { meta });
          this.resumeTaskByID(taskID);
          return ComponentAsyncState.TickResult.RESUMED;
        }
        const isReady = this.suspendedTaskReady(taskID);
        if (!isReady) {
          continue;
        }
        _debugLog("[ComponentAsyncState#tick()] resuming task via tick", {
          taskID,
          componentIdx: this.#componentIdx
        });
        this.resumeTaskByID(taskID);
        return ComponentAsyncState.TickResult.RESUMED;
      }
      const idle = this.#suspendedTaskIDs.filter((t) => t !== null).length > 0;
      return idle ? ComponentAsyncState.TickResult.IDLE : ComponentAsyncState.TickResult.DONE;
    }
    createWaitable(args) {
      return new Waitable({ target: args?.target });
    }
  }
  function getOrCreateAsyncState(componentIdx2, init) {
    if (!ASYNC_STATE.has(componentIdx2)) {
      const newState = new ComponentAsyncState({ componentIdx: componentIdx2 });
      ASYNC_STATE.set(componentIdx2, newState);
    }
    return ASYNC_STATE.get(componentIdx2);
  }
  const symbolDispose = Symbol.dispose || Symbol.for("dispose");
  function _disposeHostValue(value, disposeFn) {
    if (!disposeFn) {
      if (value === null || typeof value !== "object" && typeof value !== "function") {
        return;
      }
      if (typeof Symbol.asyncDispose === "symbol" && typeof value[Symbol.asyncDispose] === "function") {
        disposeFn = value[Symbol.asyncDispose];
      } else if (typeof value[symbolDispose] === "function") {
        disposeFn = value[symbolDispose];
      } else {
        return;
      }
    }
    const reportErr = (err) => console.error("[jco] error while disposing discarded host value", err);
    queueMicrotask(() => {
      try {
        const res = disposeFn.call(value);
        if (res && typeof res.then === "function") {
          res.then(void 0, reportErr);
        }
      } catch (err) {
        reportErr(err);
      }
    });
  }
  const GLOBAL_COMPONENT_MEMORY_MAP = /* @__PURE__ */ new Map();
  function lookupMemoriesForComponent(args) {
    const { componentIdx: componentIdx2 } = args ?? {};
    if (args.componentIdx === void 0) {
      throw new TypeError("missing component idx");
    }
    const metas = GLOBAL_COMPONENT_MEMORY_MAP.get(componentIdx2);
    if (!metas) {
      return [];
    }
    if (args.memoryIdx === void 0) {
      return Object.values(metas);
    }
    const meta = metas[args.memoryIdx];
    return meta?.memory;
  }
  class AsyncSubtask {
    static _ID = 0n;
    static State = {
      STARTING: 0,
      STARTED: 1,
      RETURNED: 2,
      CANCELLED_BEFORE_STARTED: 3,
      CANCELLED_BEFORE_RETURNED: 4
    };
    #id;
    #state = AsyncSubtask.State.STARTING;
    #componentIdx;
    #parentTask;
    #childTask = null;
    #dropped = false;
    #cancelRequested = false;
    #memoryIdx = null;
    #lenders = null;
    #waitable = null;
    #callbackFn = null;
    #callbackFnName = null;
    #postReturnFn = null;
    #onProgressFn = null;
    #pendingEventFn = null;
    #callMetadata = {};
    #resolved = false;
    #onResolveHandlers = [];
    #onStartHandlers = [];
    #result = null;
    #resultSet = false;
    // Pending value returned by a host implementation of this (async import)
    // subtask, held so it can be disposed if the guest discards the call
    #hostPendingResult = null;
    fnName;
    target;
    isAsync;
    isManualAsync;
    // One execution slice awaited by the conditional cancel trampoline.
    cancelProgress = null;
    constructor(args) {
      if (typeof args.componentIdx !== "number") {
        throw new Error("invalid componentIdx for subtask creation");
      }
      this.#componentIdx = args.componentIdx;
      this.#id = ++AsyncSubtask._ID;
      this.fnName = args.fnName;
      if (!args.parentTask) {
        throw new Error("missing parent task during subtask creation");
      }
      this.#parentTask = args.parentTask;
      if (args.childTask) {
        this.#childTask = args.childTask;
      }
      if (args.memoryIdx) {
        this.#memoryIdx = args.memoryIdx;
      }
      if (!args.waitable) {
        throw new Error("missing/invalid waitable");
      }
      this.#waitable = args.waitable;
      if (args.callMetadata) {
        this.#callMetadata = args.callMetadata;
      }
      this.#lenders = [];
      this.target = args.target;
      this.isAsync = args.isAsync;
      this.isManualAsync = args.isManualAsync;
    }
    id() {
      return this.#id;
    }
    parentTaskID() {
      return this.#parentTask?.id();
    }
    childTaskID() {
      return this.#childTask?.id();
    }
    state() {
      return this.#state;
    }
    waitable() {
      return this.#waitable;
    }
    waitableRep() {
      return this.#waitable.idx();
    }
    // The handle index is allocated only when the guest gets to see the
    // subtask (an async lower that did not complete at once), and after the
    // lifted arguments have freed theirs (Canonical ABI `canon_lower`).
    ensureHandle() {
      const existing = this.#waitable.idx();
      if (existing !== null && existing !== void 0) {
        return existing;
      }
      const idx = this.#getComponentState().handles.insert(this);
      this.#waitable.setIdx(idx);
      this.#waitable.setTarget(`waitable for subtask (waitable id [${idx}], subtask internal ID [${this.id()}])`);
      return idx;
    }
    join() {
      return this.#waitable.join(...arguments);
    }
    getPendingEvent() {
      return this.#waitable.getPendingEvent(...arguments);
    }
    hasPendingEvent() {
      return this.#waitable.hasPendingEvent(...arguments);
    }
    setPendingEvent() {
      return this.#waitable.setPendingEvent(...arguments);
    }
    setTarget(tgt) {
      this.target = tgt;
    }
    getResult() {
      if (!this.#resultSet) {
        throw new Error("subtask result has not been set");
      }
      return this.#result;
    }
    setResult(v) {
      if (this.#resultSet) {
        throw new Error("subtask result has already been set");
      }
      this.#result = v;
      this.#resultSet = true;
    }
    componentIdx() {
      return this.#componentIdx;
    }
    setChildTask(t) {
      if (!t) {
        throw new Error("cannot set missing/invalid child task on subtask");
      }
      if (this.#childTask) {
        throw new Error("child task is already set on subtask");
      }
      if (this.#parentTask === t) {
        throw new Error("parent cannot be child");
      }
      this.#childTask = t;
    }
    getChildTask(t) {
      return this.#childTask;
    }
    getParentTask() {
      return this.#parentTask;
    }
    setCallbackFn(f, name) {
      if (!f) {
        return;
      }
      if (this.#callbackFn) {
        throw new Error("callback fn can only be set once");
      }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    getCallbackFnName() {
      if (!this.#callbackFn) {
        return void 0;
      }
      return this.#callbackFn.name;
    }
    setPostReturnFn(f) {
      if (!f) {
        return;
      }
      if (this.#postReturnFn) {
        throw new Error("postReturn fn can only be set once");
      }
      this.#postReturnFn = f;
    }
    setOnProgressFn(f) {
      if (this.#onProgressFn) {
        throw new Error("on progress fn can only be set once");
      }
      this.#onProgressFn = f;
    }
    isNotStarted() {
      return this.#state == AsyncSubtask.State.STARTING;
    }
    cancellationRequested() {
      return this.#cancelRequested;
    }
    // Request cooperative cancellation of this subtask, on behalf of the
    // supertask (i.e. `canon subtask.cancel`).
    //
    // If the callee is another guest task, the request is delivered to it and
    // the callee confirms via `task.cancel` (or still resolves via `task.return`).
    //
    // If the callee is a host function, the pending call is treated as
    // immediately cancelled -- consistent with hosts being expected to resolve
    // cancellation promptly -- and any later host resolution is discarded
    // (see `AsyncTask#onResolve`). The host is notified of the discard by
    // disposing the pending value it returned (see `setHostPendingResult`).
    requestCancellation() {
      _debugLog("[AsyncSubtask#requestCancellation()] args", {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        state: this.#state,
        childTaskID: this.childTaskID(),
        fnName: this.fnName
      });
      if (this.#cancelRequested) {
        throw new Error("cancellation has already been requested for this subtask");
      }
      this.#cancelRequested = true;
      if (this.#resolved) {
        return;
      }
      if (this.#childTask) {
        this.#childTask.requestCancellation();
        return;
      }
      this.onResolve(null);
      this.#disposeHostPendingResult();
    }
    // Record the value returned by the host implementation of this subtask.
    //
    // Host imports may return a thenable that implements `Symbol.asyncDispose`
    // or `Symbol.dispose`. If the guest cancels the call before its result is
    // delivered, the result is discarded and the thenable is disposed so the
    // host can stop pending work and release anything it produced.
    setHostPendingResult(v) {
      if (v === null || typeof v !== "object" && typeof v !== "function" || typeof v.then !== "function") {
        return;
      }
      this.#hostPendingResult = v;
      if (this.#resolved && this.#state !== AsyncSubtask.State.RETURNED) {
        this.#disposeHostPendingResult();
      }
    }
    #disposeHostPendingResult() {
      const pending = this.#hostPendingResult;
      if (!pending) {
        return;
      }
      this.#hostPendingResult = null;
      _disposeHostValue(pending);
    }
    registerOnStartHandler(f) {
      this.#onStartHandlers.push(f);
    }
    onStart(args) {
      _debugLog("[AsyncSubtask#onStart()] args", {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        parentTaskID: this.parentTaskID(),
        fnName: this.fnName,
        args
      });
      if (this.#onProgressFn) {
        this.#onProgressFn();
      }
      this.#parentTask.notifyProgress();
      this.#state = AsyncSubtask.State.STARTED;
      let result;
      if (this.#callMetadata.startFn) {
        result = this.#callMetadata.startFn.apply(null, args?.startFnParams ?? []);
      }
      return result;
    }
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    reject(subtaskErr) {
      if (this.#resolved) {
        return;
      }
      if (this.#onProgressFn) {
        this.#onProgressFn();
      }
      if (this.#state === AsyncSubtask.State.STARTING) {
        this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
      } else if (this.#state === AsyncSubtask.State.STARTED) {
        this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
      } else {
        throw new Error("cannot reject a completed subtask");
      }
      this.#resolved = true;
      this.#hostPendingResult = null;
      this.#parentTask.removeSubtask(this);
      this.#parentTask.reject(subtaskErr);
    }
    onResolve(subtaskValue) {
      _debugLog("[AsyncSubtask#onResolve()] args", {
        componentIdx: this.#componentIdx,
        subtaskID: this.#id,
        isAsync: this.isAsync,
        childTaskID: this.childTaskID(),
        parentTaskID: this.parentTaskID(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        fnName: this.fnName
      });
      if (this.#resolved) {
        throw new Error("subtask has already been resolved");
      }
      if (this.#onProgressFn) {
        this.#onProgressFn();
      }
      if (subtaskValue === null && this.#cancelRequested) {
        if (this.#state === AsyncSubtask.State.STARTING) {
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_STARTED;
        } else {
          if (this.#state !== AsyncSubtask.State.STARTED) {
            throw new Error("resolved subtask must have been started before cancellation");
          }
          this.#state = AsyncSubtask.State.CANCELLED_BEFORE_RETURNED;
        }
      } else {
        if (this.#state !== AsyncSubtask.State.STARTED) {
          throw new Error("resolved subtask must have been started before completion");
        }
        this.#state = AsyncSubtask.State.RETURNED;
        this.#hostPendingResult = null;
      }
      this.setResult(subtaskValue);
      for (const f of this.#onResolveHandlers) {
        try {
          f(subtaskValue);
        } catch (err) {
          console.error("error during subtask resolve handler", err);
          throw err;
        }
      }
      const callMetadata = this.getCallMetadata();
      const memory = callMetadata.memory ?? this.#parentTask?.getReturnMemory() ?? lookupMemoriesForComponent({ componentIdx: this.#parentTask?.componentIdx() })[0];
      const returned = this.#state === AsyncSubtask.State.RETURNED;
      if (returned && callMetadata && !callMetadata.returnFn && (this.isAsync || callMetadata.funcTypeIsAsync) && callMetadata.resultPtr && memory) {
        const { resultPtr, realloc } = callMetadata;
        const lowers = callMetadata.lowers;
        if (lowers && lowers.length > 0) {
          lowers[0]({
            componentIdx: this.#componentIdx,
            memory,
            realloc,
            vals: [subtaskValue],
            storagePtr: resultPtr,
            stringEncoding: callMetadata.stringEncoding
          });
        }
      }
      this.#resolved = true;
      this.#parentTask.removeSubtask(this);
      if (!this.isAsync) {
        this.deliverResolve();
        const rep2 = this.waitableRep();
        if (rep2) {
          try {
            const removed = this.#getComponentState().handles.remove(rep2);
            if (removed !== this) {
              throw new Error("unexpectedly received non-self Subtask from handle removal");
            }
            this.drop();
          } catch (err) {
            _debugLog("[AsyncSubtask#onResolve()] failed to remove subtask after sync subtask completion", err);
          }
        }
      }
    }
    getStateNumber() {
      return this.#state;
    }
    isReturned() {
      return this.#state === AsyncSubtask.State.RETURNED;
    }
    getCallMetadata() {
      return this.#callMetadata;
    }
    isResolved() {
      if (this.#state === AsyncSubtask.State.STARTING || this.#state === AsyncSubtask.State.STARTED) {
        return false;
      }
      if (this.#state === AsyncSubtask.State.RETURNED || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_STARTED || this.#state === AsyncSubtask.State.CANCELLED_BEFORE_RETURNED) {
        return true;
      }
      throw new Error("unrecognized internal Subtask state [" + this.#state + "]");
    }
    addLender(handle) {
      _debugLog("[AsyncSubtask#addLender()] args", { handle });
      if (!Number.isNumber(handle)) {
        throw new Error("missing/invalid lender handle [" + handle + "]");
      }
      if (this.#lenders.length === 0 || this.isResolved()) {
        throw new Error("subtask has no lendors or has already been resolved");
      }
      handle.lends++;
      this.#lenders.push(handle);
    }
    deliverResolve() {
      _debugLog("[AsyncSubtask#deliverResolve()] args", {
        lenders: this.#lenders,
        parentTaskID: this.parentTaskID(),
        subtaskID: this.#id,
        childTaskID: this.childTaskID(),
        resolved: this.isResolved(),
        resolveDelivered: this.resolveDelivered()
      });
      const cannotDeliverResolve = this.resolveDelivered() || !this.isResolved();
      if (cannotDeliverResolve) {
        throw new Error("subtask cannot deliver resolution twice, and the subtask must be resolved");
      }
      for (const lender of this.#lenders) {
        lender.lends--;
      }
      this.#lenders = null;
    }
    resolveDelivered() {
      _debugLog("[AsyncSubtask#resolveDelivered()] args", {});
      if (this.#lenders === null && !this.isResolved()) {
        throw new Error("invalid subtask state, lenders missing and subtask has not been resolved");
      }
      return this.#lenders === null;
    }
    drop() {
      _debugLog("[AsyncSubtask#drop()] args", {
        componentIdx: this.#componentIdx,
        parentTaskID: this.#parentTask?.id(),
        parentTaskFnName: this.#parentTask?.entryFnName(),
        childTaskID: this.#childTask?.id(),
        childTaskFnName: this.#childTask?.entryFnName(),
        subtaskFnName: this.fnName
      });
      if (!this.#waitable) {
        throw new Error("missing/invalid inner waitable");
      }
      if (!this.resolveDelivered()) {
        throw new Error("cannot drop a subtask which has not yet resolved");
      }
      if (this.#waitable) {
        this.#waitable.drop();
      }
      this.#dropped = true;
    }
    #getComponentState() {
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error("invalid/missing async state for component [" + componentIdx + "]");
      }
      return state;
    }
    getWaitableHandleIdx() {
      _debugLog("[AsyncSubtask#getWaitableHandleIdx()] args", {});
      if (!this.#waitable) {
        throw new Error("missing/invalid waitable");
      }
      return this.waitableRep();
    }
  }
  class FutureValue {
    #start;
    #settled;
    #hideThen = 0;
    #thenFn;
    constructor(start) {
      if (typeof start !== "function") {
        throw new TypeError("future start operation must be a function");
      }
      this.#start = start;
      this.#thenFn = this.#then.bind(this);
    }
    get then() {
      return this.#hideThen === 0 ? this.#thenFn : void 0;
    }
    #read() {
      if (!this.#settled) {
        this.#settled = Promise.resolve().then(this.#start);
      }
      return this.#settled;
    }
    resolveAsValue(resolve2) {
      this.#hideThen++;
      try {
        resolve2(this);
      } finally {
        this.#hideThen--;
      }
    }
    #deliver(resolve2, value) {
      if (value instanceof FutureValue) {
        value.resolveAsValue(resolve2);
        return;
      }
      resolve2(value);
    }
    #then(resolve2, reject2) {
      return this.#read().then(
        (box) => this.#deliver(resolve2, box.value),
        reject2
      );
    }
  }
  const ASYNC_DETERMINISM = "random";
  const _coinFlip = () => {
    return Math.random() > 0.5;
  };
  const ASYNC_EVENT_CODE = {
    NONE: 0,
    SUBTASK: 1,
    STREAM_READ: 2,
    STREAM_WRITE: 3,
    FUTURE_READ: 4,
    FUTURE_WRITE: 5,
    TASK_CANCELLED: 6
  };
  function _withGlobalCurrentTaskMeta(args) {
    _debugLog("[_withGlobalCurrentTaskMeta()] args", args);
    if (!args) {
      throw new TypeError("args missing");
    }
    if (args.taskID === void 0) {
      throw new TypeError("missing task ID");
    }
    if (args.componentIdx === void 0) {
      throw new TypeError("missing component idx");
    }
    if (!args.fn) {
      throw new TypeError("missing fn");
    }
    const { taskID, componentIdx: componentIdx2, fn } = args;
    const previous = CURRENT_TASK_META[componentIdx2] ?? null;
    const previousCurrent = CURRENT_TASK_META.current ?? null;
    try {
      CURRENT_TASK_META.current = CURRENT_TASK_META[componentIdx2] = { taskID, componentIdx: componentIdx2 };
      return fn();
    } catch (err) {
      _debugLog("error while executing sync callee/callback", {
        ...args,
        err
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx2] = previous;
      CURRENT_TASK_META.current = previousCurrent;
    }
  }
  async function _withGlobalCurrentTaskMetaAsync(args) {
    _debugLog("[_withGlobalCurrentTaskMetaAsync()] args", args);
    if (!args) {
      throw new TypeError("args missing");
    }
    if (args.taskID === void 0) {
      throw new TypeError("missing task ID");
    }
    if (args.componentIdx === void 0) {
      throw new TypeError("missing component idx");
    }
    if (!args.fn) {
      throw new TypeError("missing fn");
    }
    const { taskID, componentIdx: componentIdx2, fn } = args;
    try {
      CURRENT_TASK_META.current = CURRENT_TASK_META[componentIdx2] = { taskID, componentIdx: componentIdx2 };
      return await fn();
    } catch (err) {
      _debugLog("error while executing async callee/callback", {
        ...args,
        err
      });
      throw err;
    } finally {
      CURRENT_TASK_META[componentIdx2] = null;
      if (CURRENT_TASK_META.current?.taskID === taskID) {
        CURRENT_TASK_META.current = null;
      }
    }
  }
  class AsyncTask {
    static _ID = 0n;
    static State = {
      INITIAL: "initial",
      CANCELLED: "cancelled",
      CANCEL_PENDING: "cancel-pending",
      CANCEL_DELIVERED: "cancel-delivered",
      RESOLVED: "resolved"
    };
    static BlockResult = {
      CANCELLED: "block.cancelled",
      NOT_CANCELLED: "block.not-cancelled"
    };
    #id;
    #componentIdx;
    #state;
    #isAsync;
    #isManualAsync;
    #callingWasmExport = true;
    #lockFreeEntry = false;
    #preserveFutureResult;
    #entryFnName = null;
    #onResolveHandlers = [];
    #progressWaiters = [];
    #completionPromise = null;
    #completionValue;
    #completionReady = false;
    #settleCompletionPromise;
    #rejected = false;
    #exitPromise = null;
    #onExitHandlers = [];
    #memoryIdx = null;
    #memory = null;
    #callbackFn = null;
    #callbackFnName = null;
    #postReturnFn = null;
    #getCalleeParamsFn = null;
    #calleeIsAsync = null;
    #admissionTicket = null;
    #funcTypeIsAsync = false;
    #returnResultTypeIdx = null;
    #stringEncoding = null;
    #parentSubtask = null;
    #errHandling;
    #backpressurePromise;
    #backpressureWaiters = 0n;
    #returnLowerFns = null;
    #resourceScopeId;
    #resourceBorrowCount = 0;
    #resourceLenders = [];
    #resourceScopeExited = false;
    #subtasks = [];
    #entered = false;
    #exited = false;
    #errored = null;
    cancelled = false;
    cancelRequested = false;
    alwaysTaskReturn = false;
    returnCalls = 0;
    storage = [0, 0];
    tmpRetI64HighBits = 0 | 0;
    constructor(opts) {
      this.#id = ++AsyncTask._ID;
      this.#resourceScopeId = ++RESOURCE_SCOPE_ID;
      RESOURCE_SCOPE_TASKS.set(this.#resourceScopeId, this);
      if (opts?.componentIdx === void 0) {
        throw new TypeError("missing component id during task creation");
      }
      this.#componentIdx = opts.componentIdx;
      this.#state = AsyncTask.State.INITIAL;
      this.#isAsync = opts?.isAsync ?? false;
      this.#isManualAsync = opts?.isManualAsync ?? false;
      this.#preserveFutureResult = opts?.preserveFutureResult ?? false;
      this.#entryFnName = opts.entryFnName;
      this.#callingWasmExport = opts?.callingWasmExport !== false;
      const {
        promise: completionPromise,
        resolve: resolveCompletionPromise,
        reject: rejectCompletionPromise
      } = promiseWithResolvers();
      this.#completionPromise = completionPromise;
      completionPromise.catch(() => {
      });
      let completionSettled = false;
      const settleCompletionPromise = () => {
        if (completionSettled || !this.#completionReady) {
          return;
        }
        completionSettled = true;
        if (this.#errored !== null) {
          rejectCompletionPromise(this.#errored);
        } else if (this.#rejected) {
          rejectCompletionPromise(this.#completionValue);
        } else if (this.#preserveFutureResult && this.#completionValue instanceof FutureValue) {
          this.#completionValue.resolveAsValue(resolveCompletionPromise);
        } else {
          resolveCompletionPromise(this.#completionValue);
        }
      };
      this.#settleCompletionPromise = settleCompletionPromise;
      this.#onResolveHandlers.push((results) => {
        if (this.#parentSubtask !== null) {
          return;
        }
        if (!this.#isAsync && !this.#isManualAsync) {
          return;
        }
        this.#completionValue = results;
        this.#completionReady = true;
      });
      const {
        promise: exitPromise,
        resolve: resolveExitPromise,
        reject: rejectExitPromise
      } = promiseWithResolvers();
      this.#exitPromise = exitPromise;
      this.#onExitHandlers.push(() => {
        if (this.#parentSubtask === null && (this.#isAsync || this.#isManualAsync)) {
          settleCompletionPromise();
        }
        resolveExitPromise();
      });
      if (opts.callbackFn) {
        this.#callbackFn = opts.callbackFn;
      }
      if (opts.callbackFnName) {
        this.#callbackFnName = opts.callbackFnName;
      }
      if (opts.getCalleeParamsFn) {
        this.#getCalleeParamsFn = opts.getCalleeParamsFn;
      }
      if (opts.stringEncoding) {
        this.#stringEncoding = opts.stringEncoding;
      }
      if (opts.parentSubtask) {
        this.#parentSubtask = opts.parentSubtask;
      }
      if (opts.errHandling) {
        this.#errHandling = opts.errHandling;
      }
    }
    taskState() {
      return this.#state;
    }
    id() {
      return this.#id;
    }
    componentIdx() {
      return this.#componentIdx;
    }
    entryFnName() {
      return this.#entryFnName;
    }
    resourceScopeId() {
      return this.#resourceScopeId;
    }
    addBorrowedHandle() {
      if (this.#resourceScopeExited) {
        throw new Error("cannot add a borrow to an exited resource scope");
      }
      this.#resourceBorrowCount++;
    }
    removeBorrowedHandle() {
      if (this.#resourceBorrowCount === 0) {
        throw new Error("resource borrow count underflow");
      }
      this.#resourceBorrowCount--;
    }
    addResourceLender(table, handle) {
      if (this.#resourceScopeExited) {
        throw new Error("cannot add a lender to an exited resource scope");
      }
      this.#resourceLenders.push({ table, handle });
    }
    validateResourceBorrowScope() {
      if (this.#resourceScopeExited) {
        return;
      }
      if (this.#resourceBorrowCount !== 0) {
        throw new WebAssemblyRuntimeError("borrow handles still remain at the end of the call");
      }
      for (const { table, handle } of this.#resourceLenders) {
        const idx = handle << 1;
        const lendCount = table[idx];
        if (!Number.isInteger(lendCount) || lendCount <= 0 || lendCount >= 2 ** 30) {
          throw new Error("invalid resource lender state at scope exit");
        }
        table[idx] = lendCount - 1;
      }
      this.#resourceLenders = [];
      this.#resourceScopeExited = true;
      RESOURCE_SCOPE_TASKS.delete(this.#resourceScopeId);
    }
    completionPromise() {
      return this.#completionPromise;
    }
    settleCompletion() {
      this.#settleCompletionPromise();
    }
    exitPromise() {
      return this.#exitPromise;
    }
    waitForProgress() {
      const { promise: promise2, resolve: resolve2 } = promiseWithResolvers();
      this.#progressWaiters.push(resolve2);
      return promise2;
    }
    notifyProgress() {
      const waiters = this.#progressWaiters;
      this.#progressWaiters = [];
      for (const resolve2 of waiters) {
        resolve2();
      }
    }
    isAsync() {
      return this.#isAsync;
    }
    isManualAsync() {
      return this.#isManualAsync;
    }
    isSync() {
      return !this.isAsync();
    }
    getErrHandling() {
      return this.#errHandling;
    }
    hasCallback() {
      return this.#callbackFn !== null;
    }
    getReturnMemoryIdx() {
      return this.#memoryIdx;
    }
    setReturnMemoryIdx(idx) {
      if (idx === null) {
        return;
      }
      this.#memoryIdx = idx;
    }
    getReturnMemory() {
      return this.#memory;
    }
    setReturnMemory(m) {
      if (m === null) {
        return;
      }
      this.#memory = m;
    }
    setReturnLowerFns(fns) {
      this.#returnLowerFns = fns;
    }
    getReturnLowerFns() {
      return this.#returnLowerFns;
    }
    setCalleeIsAsync(value) {
      if (typeof value !== "boolean") {
        throw new TypeError("callee async state must be a boolean");
      }
      this.#calleeIsAsync = value;
    }
    setParentSubtask(subtask) {
      if (!subtask || !(subtask instanceof AsyncSubtask)) {
        return;
      }
      if (this.#parentSubtask) {
        throw new Error("parent subtask can only be set once");
      }
      this.#parentSubtask = subtask;
    }
    getParentSubtask() {
      return this.#parentSubtask;
    }
    // TODO(threads): this is very inefficient, we can pass along a root task,
    // and ideally do not need this once thread support is in place
    getRootTask() {
      let currentSubtask = this.getParentSubtask();
      let task = this;
      while (currentSubtask) {
        task = currentSubtask.getParentTask();
        currentSubtask = task.getParentSubtask();
      }
      return task;
    }
    setPostReturnFn(f) {
      if (!f) {
        return;
      }
      if (this.#postReturnFn) {
        throw new Error("postReturn fn can only be set once");
      }
      this.#postReturnFn = f;
    }
    setCallbackFn(f, name) {
      if (!f) {
        return;
      }
      if (this.#callbackFn) {
        throw new Error("callback fn can only be set once");
      }
      this.#callbackFn = f;
      this.#callbackFnName = name;
    }
    getCallbackFnName() {
      if (!this.#callbackFnName) {
        return void 0;
      }
      return this.#callbackFnName;
    }
    runCallbackFn(...args) {
      if (!this.#callbackFn) {
        throw new Error("no callback function has been set for task");
      }
      if (this.#callbackFn._jcoMaySuspend === false) {
        return _withGlobalCurrentTaskMeta({
          taskID: this.#id,
          componentIdx: this.#componentIdx,
          fn: () => this.#callbackFn.apply(null, args)
        });
      }
      return _withGlobalCurrentTaskMetaAsync({
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        fn: () => {
          return this.#callbackFn.apply(null, args);
        }
      });
    }
    getCalleeParams() {
      if (!this.#getCalleeParamsFn) {
        throw new Error("missing/invalid getCalleeParamsFn");
      }
      return this.#getCalleeParamsFn();
    }
    // Legacy manually-async exports are sync-typed in the component
    // but use JSPI precisely so their guest stack may suspend.
    // Canonical ABI: only sync-typed callees may not block (`canon_lift`);
    // an async-lifted callee may, even when called through a sync lowering.
    mayBlock() {
      return this.isAsync() || this.isManualAsync() || this.isResolvedState() || this.#funcTypeIsAsync;
    }
    // (an async-typed function may block however it was lifted)
    setFuncTypeIsAsync(v) {
      this.#funcTypeIsAsync = v;
    }
    // The interned result type of the task's function (checked by `task.return`)
    setReturnResultTypeIdx(v) {
      this.#returnResultTypeIdx = v;
    }
    returnResultTypeIdx() {
      return this.#returnResultTypeIdx;
    }
    mayEnter(task) {
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (cstate.hasBackpressure()) {
        _debugLog("[AsyncTask#mayEnter()] disallowed due to backpressure", { taskID: this.#id });
        return false;
      }
      if (!cstate.callingSyncImport()) {
        _debugLog("[AsyncTask#mayEnter()] disallowed due to sync import call", { taskID: this.#id });
        return false;
      }
      const callingSyncExportWithSyncPending = cstate.callingSyncExport && !task.isAsync;
      if (!callingSyncExportWithSyncPending) {
        _debugLog("[AsyncTask#mayEnter()] disallowed due to sync export w/ sync pending", { taskID: this.#id });
        return false;
      }
      return true;
    }
    enterSync() {
      if (this.needsExclusiveLock()) {
        const cstate = getOrCreateAsyncState(this.#componentIdx);
        if (!cstate.isExclusivelyLocked()) {
          cstate.exclusiveLock(this.#id);
        } else {
          this.#lockFreeEntry = true;
          _debugLog("[AsyncTask#enterSync()] entering without exclusive lock", {
            taskID: this.#id,
            componentIdx: this.#componentIdx
          });
        }
      }
      return true;
    }
    tryEnter() {
      if (this.#entered) {
        throw new Error(`task with ID [${this.#id}] should not be entered twice`);
      }
      if (this.deliverPendingCancel({ cancellable: true })) {
        this.cancel();
        return false;
      }
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (this.isSync()) {
        this.#entered = true;
        return true;
      }
      if (cstate.hasBackpressure()) {
        return null;
      }
      if (cstate.hasPendingAdmissions()) {
        return null;
      }
      if (this.needsExclusiveLock()) {
        if (cstate.isExclusivelyLocked()) {
          return null;
        }
        cstate.exclusiveLock(this.#id);
      }
      if (this.deliverPendingCancel({ cancellable: true })) {
        cstate.exclusiveRelease(this.#id);
        this.cancel();
        return false;
      }
      this.#entered = true;
      return true;
    }
    async enter(opts) {
      _debugLog("[AsyncTask#enter()] args", {
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        subtaskID: this.getParentSubtask()?.id(),
        args: opts,
        entryFnName: this.#entryFnName
      });
      if (this.#entered) {
        throw new Error(`task with ID [${this.#id}] should not be entered twice`);
      }
      if (this.deliverPendingCancel({ cancellable: true })) {
        this.cancel();
        return false;
      }
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (opts?.isHost) {
        this.#entered = true;
        const parentTask = this.#parentSubtask?.getParentTask();
        if (parentTask?.taskState() === AsyncTask.State.CANCEL_DELIVERED || parentTask && !parentTask.hasCallback()) {
          parentTask.notifyProgress();
        }
        return this.#entered;
      }
      if (this.isSync()) {
        this.#entered = true;
        if (this.#isManualAsync) {
          if (this.needsExclusiveLock()) {
            await cstate.acquireExclusiveLock(this.#id);
          }
        }
        return this.#entered;
      }
      const ticket = cstate.takeAdmissionTicket(this.#id);
      this.#admissionTicket = ticket;
      let entered = false;
      try {
        entered = await this.#enterQueued(cstate, ticket);
        return entered;
      } finally {
        if (!entered) {
          this.endFirstSlice();
        }
      }
    }
    // The first slice of this task ended (it returned, blocked or trapped):
    // the next entry into the instance may be admitted (Canonical ABI
    // `Store.invoke` runs a call until it first blocks or returns).
    endFirstSlice() {
      const ticket = this.#admissionTicket;
      if (ticket === null) {
        return;
      }
      this.#admissionTicket = null;
      getOrCreateAsyncState(this.#componentIdx).releaseAdmissionTicket(ticket);
    }
    async #enterQueued(cstate, ticket) {
      await cstate.waitForAdmissionTurn(ticket);
      if (this.isResolvedState() || this.isCancelled()) {
        return false;
      }
      while (true) {
        if (cstate.hasBackpressure()) {
          cstate.addBackpressureWaiter();
          const result = await this.waitUntil({
            readyFn: () => {
              return !cstate.hasBackpressure();
            },
            cancellable: true
          });
          cstate.removeBackpressureWaiter();
          if (!result || this.isCancelled()) {
            if (!this.isResolvedState()) {
              this.cancel();
            }
            return false;
          }
        }
        if (this.needsExclusiveLock()) {
          await cstate.acquireExclusiveLock(this.#id);
          if (cstate.hasBackpressure()) {
            cstate.exclusiveRelease(this.#id);
            continue;
          }
        }
        break;
      }
      try {
        cstate.throwIfInterrupted();
      } catch (err) {
        cstate.exclusiveRelease(this.#id);
        this.setErrored(err);
        return false;
      }
      if (this.isResolvedState() || this.isCancelled()) {
        cstate.exclusiveRelease(this.#id);
        return false;
      }
      if (this.deliverPendingCancel({ cancellable: true })) {
        cstate.exclusiveRelease(this.#id);
        this.cancel();
        return false;
      }
      this.#entered = true;
      return this.#entered;
    }
    isRunningState() {
      return this.#state !== AsyncTask.State.RESOLVED;
    }
    isResolvedState() {
      return this.#state === AsyncTask.State.RESOLVED;
    }
    isResolved() {
      return this.#state === AsyncTask.State.RESOLVED;
    }
    isExited() {
      return this.#exited;
    }
    async waitUntil(opts) {
      const { readyFn, cancellable } = opts;
      _debugLog("[AsyncTask#waitUntil()] args", { taskID: this.#id, args: { cancellable } });
      const keepGoing = await this.suspendUntil({
        readyFn,
        cancellable
      });
      return keepGoing;
    }
    async yieldUntil(opts) {
      const { readyFn, cancellable } = opts;
      _debugLog("[AsyncTask#yieldUntil()]", {
        taskID: this.#id,
        args: {
          cancellable
        },
        componentIdx: this.#componentIdx
      });
      const keepGoing = await this.immediateSuspend({ readyFn, cancellable });
      if (keepGoing) {
        return {
          code: ASYNC_EVENT_CODE.NONE,
          payload0: 0,
          payload1: 0
        };
      }
      return {
        code: ASYNC_EVENT_CODE.TASK_CANCELLED,
        payload0: 0,
        payload1: 0
      };
    }
    async suspendUntil(opts) {
      const { cancellable, readyFn } = opts;
      _debugLog("[AsyncTask#suspendUntil()] args", {
        taskID: this.#id,
        args: {
          cancellable
        },
        componentIdx: this.#componentIdx
      });
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) {
        return false;
      }
      const completed = await this.immediateSuspendUntil({ readyFn, cancellable });
      return completed;
    }
    suspendUntilCallback(opts, onResume) {
      const { cancellable, readyFn } = opts;
      if (this.deliverPendingCancel({ cancellable })) {
        onResume(false);
        return;
      }
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      cstate.suspendTask({
        task: this,
        cancellable,
        readyFn: () => {
          if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
            return true;
          }
          return readyFn();
        },
        onResume: (keepGoing) => {
          if (keepGoing && this.deliverPendingCancel({ cancellable })) {
            keepGoing = false;
          }
          onResume(keepGoing);
        }
      });
    }
    // TODO(threads): equivalent to thread.suspend_until()
    async immediateSuspendUntil(opts) {
      const { cancellable, readyFn } = opts;
      _debugLog("[AsyncTask#immediateSuspendUntil()] args", {
        args: {
          cancellable,
          readyFn
        },
        taskID: this.#id,
        componentIdx: this.#componentIdx
      });
      const ready = readyFn();
      if (ready && ASYNC_DETERMINISM === "random") {
        const coinFlip = _coinFlip();
        if (coinFlip) {
          return true;
        }
      }
      const keepGoing = await this.immediateSuspend({ cancellable, readyFn });
      return keepGoing;
    }
    async immediateSuspend(opts) {
      this.settleCompletion();
      const { cancellable, readyFn } = opts;
      _debugLog("[AsyncTask#immediateSuspend()] args", { cancellable, readyFn });
      const pendingCancelled = this.deliverPendingCancel({ cancellable });
      if (pendingCancelled) {
        return false;
      }
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      const keepGoing = await cstate.suspendTask({
        task: this,
        cancellable,
        readyFn: () => {
          if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
            return true;
          }
          return readyFn();
        }
      });
      if (keepGoing && this.deliverPendingCancel({ cancellable })) {
        return false;
      }
      return keepGoing;
    }
    deliverPendingCancel(opts) {
      const { cancellable } = opts;
      _debugLog("[AsyncTask#deliverPendingCancel()]", {
        args: { cancellable },
        taskID: this.#id,
        componentIdx: this.#componentIdx
      });
      if (cancellable && this.#state === AsyncTask.State.CANCEL_PENDING) {
        this.#state = AsyncTask.State.CANCEL_DELIVERED;
        return true;
      }
      return false;
    }
    isCancelled() {
      return this.cancelled;
    }
    cancellationRequested() {
      return this.cancelRequested;
    }
    // Request cooperative cancellation of this task, called on behalf of a
    // supertask performing `subtask.cancel` on the subtask this task backs.
    //
    // The request is delivered at this task's next cancellable wait
    // (see suspendUntil/immediateSuspend), at which point the task is
    // expected to acknowledge via `task.cancel` or still resolve via
    // `task.return`.
    requestCancellation() {
      _debugLog("[AsyncTask#requestCancellation()] args", {
        taskID: this.#id,
        componentIdx: this.#componentIdx,
        state: this.#state
      });
      if (this.isResolvedState() || this.cancelRequested) {
        return;
      }
      this.cancelRequested = true;
      if (this.#state === AsyncTask.State.INITIAL) {
        this.#state = AsyncTask.State.CANCEL_PENDING;
        if (!this.#entered) {
          this.deliverPendingCancel({ cancellable: true });
          this.cancel();
          const cstate = getOrCreateAsyncState(this.#componentIdx);
          cstate.resumeTaskByID(this.#id);
          cstate.cancelExclusiveLockWaiter(this.#id);
          this.exit({ skipExclusiveLockCheck: true });
          return;
        }
      }
      getOrCreateAsyncState(this.#componentIdx).runTickLoop();
    }
    cancel(args) {
      _debugLog("[AsyncTask#cancel()] args", {});
      if (this.taskState() !== AsyncTask.State.CANCEL_DELIVERED) {
        throw new Error("`task.cancel` called by task which has not been cancelled");
      }
      this.validateResourceBorrowScope();
      this.cancelled = true;
      this.onResolve(args?.error ?? null);
      this.#state = AsyncTask.State.RESOLVED;
      if (!this.#entered) {
        this.notifyProgress();
      }
    }
    onResolve(taskValue) {
      const handlers = this.#onResolveHandlers;
      this.#onResolveHandlers = [];
      for (const f of handlers) {
        try {
          f(taskValue);
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      if (this.#rejected) {
        this.#parentSubtask?.reject(taskValue);
        return;
      }
      const parentSubtaskPending = this.#parentSubtask && !this.#parentSubtask.isResolved();
      const taskReturned = !this.isCancelled();
      if (parentSubtaskPending && taskReturned) {
        const meta = this.#parentSubtask.getCallMetadata();
        if (meta.returnFn && !meta.returnFnCalled) {
          _debugLog("[AsyncTask#onResolve()] running returnFn", {
            componentIdx: this.#componentIdx,
            taskID: this.#id,
            subtaskID: this.#parentSubtask.id()
          });
          const callerTask = this.#parentSubtask.getParentTask();
          _withGlobalCurrentTaskMeta({
            taskID: callerTask.id(),
            componentIdx: callerTask.componentIdx(),
            fn: () => meta.returnFn.apply(null, [taskValue, meta.resultPtr])
          });
          meta.returnFnCalled = true;
        }
      }
      if (this.#postReturnFn && taskReturned) {
        _debugLog("[AsyncTask#onResolve()] running post return ", {
          componentIdx: this.#componentIdx,
          taskID: this.#id
        });
        try {
          _withGlobalCurrentTaskMeta({
            taskID: this.#id,
            componentIdx: this.#componentIdx,
            fn: () => this.#postReturnFn(taskValue)
          });
        } catch (err) {
          _debugLog("[AsyncTask#onResolve] error during task resolve handler", err);
          throw err;
        }
      }
      if (parentSubtaskPending) {
        this.#parentSubtask.onResolve(taskValue);
      }
    }
    registerOnResolveHandler(f) {
      this.#onResolveHandlers.push(f);
    }
    isRejected() {
      return this.#rejected;
    }
    isErrored() {
      return this.#errored;
    }
    setErrored(err) {
      if (this.#errored === null) {
        this.#errored = err;
      }
    }
    reject(taskErr) {
      _debugLog("[AsyncTask#reject()] args", {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        parentSubtask: this.#parentSubtask,
        parentSubtaskID: this.#parentSubtask?.id(),
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName,
        errMsg: taskErr.message
      });
      this.setErrored(taskErr);
      if (this.#rejected) {
        return;
      }
      if (this.isResolvedState()) {
        this.#rejected = true;
        this.#errored = taskErr;
        const parentTask = this.#parentSubtask?.getParentTask();
        if (parentTask) {
          parentTask.reject(taskErr);
        }
        return;
      }
      this.#rejected = true;
      this.cancelRequested = true;
      this.#state = AsyncTask.State.CANCEL_PENDING;
      const cancelled = this.deliverPendingCancel({ cancellable: true });
      this.cancel({ error: taskErr });
    }
    resolve(results) {
      _debugLog("[AsyncTask#resolve()] args", {
        componentIdx: this.#componentIdx,
        taskID: this.#id,
        entryFnName: this.entryFnName(),
        callbackFnName: this.#callbackFnName
      });
      if (this.#state === AsyncTask.State.RESOLVED) {
        if (this.#errored !== null) {
          throw this.#errored;
        }
        throw new Error(`(component [${this.#componentIdx}]) task [${this.#id}]  is already resolved (did you forget to wait for an import?)`);
      }
      this.validateResourceBorrowScope();
      this.#state = AsyncTask.State.RESOLVED;
      switch (results.length) {
        case 0:
          this.onResolve(void 0);
          break;
        case 1:
          this.onResolve(results[0]);
          break;
        default:
          _debugLog("[AsyncTask#resolve()] unexpected number of results", {
            componentIdx: this.#componentIdx,
            results,
            taskID: this.#id,
            subtaskID: this.#parentSubtask?.id(),
            entryFnName: this.#entryFnName,
            callbackFnName: this.#callbackFnName
          });
          throw new Error("unexpected number of results");
      }
    }
    exit(args) {
      _debugLog("[AsyncTask#exit()]", {
        componentIdx: this.#componentIdx,
        taskID: this.#id
      });
      this.endFirstSlice();
      if (this.#exited) {
        throw new Error("task has already exited");
      }
      if (this.#state !== AsyncTask.State.RESOLVED) {
        throw new WebAssemblyRuntimeError(`(component [${this.#componentIdx}]) task [${this.#id}] exited without resolution`);
      }
      this.validateResourceBorrowScope();
      const state = getOrCreateAsyncState(this.#componentIdx);
      if (!state) {
        throw new Error("missing async state for component [" + this.#componentIdx + "]");
      }
      if (this.#componentIdx !== -1 && !args?.skipExclusiveLockCheck && !this.#lockFreeEntry) {
        if (this.needsExclusiveLock() && !state.exclusivelyLockedBy(this.#id)) {
          throw new Error(`task [${this.#id}] exit: component [${this.#componentIdx}] should have been exclusively locked by it`);
        }
      }
      state.exclusiveRelease(this.#id);
      this.notifyProgress();
      for (const f of this.#onExitHandlers) {
        try {
          f();
        } catch (err) {
          console.error("error during task exit handler", err);
          throw err;
        }
      }
      this.#exited = true;
      clearCurrentTask(this.#componentIdx, this.id());
    }
    needsExclusiveLock() {
      if (this.#componentIdx === -1) {
        return false;
      }
      if (!this.#callingWasmExport) {
        return false;
      }
      return !this.#isAsync || this.hasCallback() || this.#calleeIsAsync === false;
    }
    createSubtask(args) {
      _debugLog("[AsyncTask#createSubtask()] args", args);
      const { componentIdx: componentIdx2, childTask, callMetadata, fnName, isAsync, isManualAsync } = args;
      const cstate = getOrCreateAsyncState(this.#componentIdx);
      if (!cstate) {
        throw new Error(`invalid/missing async state for component idx [${componentIdx2}]`);
      }
      const waitable = new Waitable({
        componentIdx: this.#componentIdx,
        target: `subtask (internal ID [${this.#id}])`
      });
      const newSubtask = new AsyncSubtask({
        componentIdx: componentIdx2,
        childTask,
        parentTask: this,
        callMetadata,
        isAsync,
        isManualAsync,
        fnName,
        waitable
      });
      this.#subtasks.push(newSubtask);
      newSubtask.setTarget(`subtask (internal ID [${newSubtask.id()}], waitable [${waitable.idx()}], component [${componentIdx2}])`);
      return newSubtask;
    }
    getLatestSubtask() {
      return this.#subtasks.at(-1);
    }
    getSubtaskByWaitableRep(rep2) {
      if (rep2 === void 0) {
        throw new TypeError("missing rep");
      }
      return this.#subtasks.find((s) => s.waitableRep() === rep2);
    }
    currentSubtask() {
      _debugLog("[AsyncTask#currentSubtask()]");
      if (this.#subtasks.length === 0) {
        return void 0;
      }
      return this.#subtasks.at(-1);
    }
    removeSubtask(subtask) {
      if (this.#subtasks.length === 0) {
        throw new Error("cannot end current subtask: no current subtask");
      }
      this.#subtasks = this.#subtasks.filter((t) => t !== subtask);
      return subtask;
    }
  }
  function createNewCurrentTask(args) {
    _debugLog("[createNewCurrentTask()] args", args);
    const {
      componentIdx: componentIdx2,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      parentSubtaskID,
      callbackFnName,
      getCallbackFn,
      getParamsFn,
      stringEncoding,
      errHandling,
      getCalleeParamsFn,
      resultPtr,
      callingWasmExport
    } = args;
    if (componentIdx2 === void 0 || componentIdx2 === null) {
      throw new Error("missing/invalid component instance index while starting task");
    }
    let taskMetas = ASYNC_TASKS_BY_COMPONENT_IDX.get(componentIdx2);
    const callbackFn = getCallbackFn ? getCallbackFn() : null;
    const newTask = new AsyncTask({
      componentIdx: componentIdx2,
      isAsync,
      isManualAsync,
      preserveFutureResult,
      entryFnName,
      callbackFn,
      callbackFnName,
      stringEncoding,
      getCalleeParamsFn,
      resultPtr,
      errHandling,
      callingWasmExport
    });
    const newTaskID = newTask.id();
    const newTaskMeta = { id: newTaskID, componentIdx: componentIdx2, task: newTask };
    ASYNC_CURRENT_TASK_IDS.push(newTaskID);
    ASYNC_CURRENT_COMPONENT_IDXS.push(componentIdx2);
    if (!taskMetas) {
      taskMetas = [newTaskMeta];
      ASYNC_TASKS_BY_COMPONENT_IDX.set(componentIdx2, [newTaskMeta]);
    } else {
      taskMetas.push(newTaskMeta);
    }
    return [newTask, newTaskID];
  }
  function _checkMayLeave(componentIdx2) {
    if (INSTANCE_FLAGS.get(componentIdx2)?.value !== 1) {
      throw new WebAssemblyRuntimeError("cannot leave component instance");
    }
  }
  function _getGlobalCurrentTaskMeta(componentIdx2) {
    const v = componentIdx2 === void 0 || componentIdx2 === null ? CURRENT_TASK_META.current : CURRENT_TASK_META[componentIdx2];
    if (v === void 0 || v === null) {
      return void 0;
    }
    return { ...v };
  }
  function _setGlobalCurrentTaskMeta(args) {
    if (!args) {
      throw new TypeError("args missing");
    }
    if (args.taskID === void 0) {
      throw new TypeError("missing task ID");
    }
    if (args.componentIdx === void 0) {
      throw new TypeError("missing component idx");
    }
    const { taskID, componentIdx: componentIdx2 } = args;
    return CURRENT_TASK_META.current = CURRENT_TASK_META[componentIdx2] = { taskID, componentIdx: componentIdx2 };
  }
  async function _clearCurrentTask(args) {
    _debugLog("[_clearCurrentTask()] args", args);
    if (!args) {
      throw new TypeError("args missing");
    }
    if (args.taskID === void 0) {
      throw new TypeError("missing task ID");
    }
    if (args.componentIdx === void 0) {
      throw new TypeError("missing component idx");
    }
    const { taskID, componentIdx: componentIdx2 } = args;
    const meta = CURRENT_TASK_META[componentIdx2];
    if (!meta) {
      throw new Error(`missing current task meta for component idx [${componentIdx2}]`);
    }
    if (meta.taskID !== taskID) {
      throw new Error(`task ID [${meta.taskID}] != requested ID [${taskID}]`);
    }
    if (meta.componentIdx !== componentIdx2) {
      throw new Error(`component idx [${meta.componentIdx}] != requested idx [${componentIdx2}]`);
    }
    CURRENT_TASK_META[componentIdx2] = null;
    if (CURRENT_TASK_META.current?.taskID === taskID) {
      CURRENT_TASK_META.current = null;
    }
  }
  function _lowerImportBackwardsCompat(args) {
    const params = [...arguments].slice(1);
    _debugLog("[_lowerImportBackwardsCompat()] args", { args, params });
    const {
      functionIdx,
      componentIdx: componentIdx2,
      isAsync,
      isManualAsync,
      paramLiftFns,
      resultLowerFns,
      hasResultPointer,
      funcTypeIsAsync,
      metadata,
      memoryIdx,
      getMemoryFn,
      getReallocFn,
      importFn,
      stringEncoding
    } = args;
    _checkMayLeave(componentIdx2);
    const meta = _getGlobalCurrentTaskMeta(componentIdx2);
    let taskMeta = meta && getCurrentTask(componentIdx2, meta.taskID);
    let createdTask;
    if (!taskMeta) {
      if (funcTypeIsAsync || isAsync && !isManualAsync) {
        throw new Error("p3 async wasm exports cannot use backwards compat auto-task init");
      }
      const [newTask, newTaskID] = createNewCurrentTask({
        componentIdx: componentIdx2,
        isAsync,
        isManualAsync,
        callingWasmExport: false
      });
      createdTask = newTask;
      createdTask.registerOnResolveHandler(() => {
        _clearCurrentTask({
          taskID: task.id(),
          componentIdx: task.componentIdx()
        });
      });
      _setGlobalCurrentTaskMeta({
        componentIdx: componentIdx2,
        taskID: newTaskID
      });
      taskMeta = getCurrentTask(componentIdx2, newTaskID);
    }
    if (!taskMeta) {
      throw new Error("invalid/missing async task meta");
    }
    const task = taskMeta.task;
    if (!task) {
      throw new Error("invalid/missing async task");
    }
    const cstate = getOrCreateAsyncState(componentIdx2);
    if (!task.mayBlock() && funcTypeIsAsync && !isAsync) {
      throw new Error("non async exports cannot synchronously call async functions");
    }
    const memory = getMemoryFn();
    const resultPtr = hasResultPointer ? params[params.length - 1] >>> 0 : void 0;
    const subtask = task.createSubtask({
      componentIdx: componentIdx2,
      parentTask: task,
      fnName: importFn.fnName,
      isAsync,
      isManualAsync,
      callMetadata: {
        memoryIdx,
        memory,
        realloc: getReallocFn?.(),
        getReallocFn,
        resultPtr,
        lowers: resultLowerFns,
        funcTypeIsAsync,
        stringEncoding
      }
    });
    task.setReturnMemoryIdx(memoryIdx);
    task.setReturnMemory(getMemoryFn());
    subtask.onStart();
    if (!isManualAsync && !isAsync && !funcTypeIsAsync) {
      if (createdTask) {
        createdTask.enterSync();
      }
      const res = importFn(...params);
      if (!funcTypeIsAsync && !subtask.isReturned()) {
        throw new Error("post-execution subtasks must either be async or returned");
      }
      const syncRes = subtask.getResult();
      if (createdTask) {
        createdTask.resolve([syncRes]);
      }
      return syncRes;
    }
    if (!isManualAsync && !isAsync && funcTypeIsAsync) {
      const { promise: promise2, resolve: resolve2, reject: reject2 } = promiseWithResolvers();
      queueMicrotask(async () => {
        try {
          await importFn(...params);
          if (!subtask.isResolved()) {
            await task.suspendUntil({ readyFn: () => subtask.isResolved() });
          }
          resolve2(subtask.getResult());
        } catch (err) {
          reject2(err);
        }
      });
      return promise2;
    }
    const subtaskState = subtask.getStateNumber();
    if (subtaskState < 0 || subtaskState >= 2 ** 4) {
      throw new Error("invalid subtask state, out of valid range");
    }
    subtask.setOnProgressFn(() => {
      subtask.setPendingEvent(() => {
        if (subtask.isResolved()) {
          subtask.deliverResolve();
        }
        const event = {
          code: ASYNC_EVENT_CODE.SUBTASK,
          payload0: subtask.waitableRep(),
          payload1: subtask.getStateNumber()
        };
        return event;
      });
    });
    const requiresManualAsyncResult = !isAsync && !funcTypeIsAsync && isManualAsync;
    let manualAsyncResult;
    if (requiresManualAsyncResult) {
      manualAsyncResult = promiseWithResolvers();
    }
    queueMicrotask(async () => {
      try {
        _debugLog("[_lowerImportBackwardsCompat()] calling lowered import", { importFn, params });
        if (createdTask) {
          await createdTask.enter();
        }
        const asyncRes = await importFn(...params);
        if (requiresManualAsyncResult) {
          manualAsyncResult.resolve(subtask.getResult());
        }
        if (createdTask) {
          createdTask.resolve([asyncRes]);
        }
      } catch (err) {
        _debugLog("[_lowerImportBackwardsCompat()] import fn error:", err);
        if (requiresManualAsyncResult) {
          manualAsyncResult.reject(err);
          return;
        }
        task.setErrored(err);
        task.reject(err);
      }
    });
    if (requiresManualAsyncResult) {
      return manualAsyncResult.promise;
    }
    _debugLog("[_lowerImportBackwardsCompat()] async-lowered import return", {
      fnName: importFn.fnName,
      componentIdx: componentIdx2,
      subtaskID: subtask.id(),
      waitableRep: subtask.waitableRep(),
      subtaskState,
      packedResult: Number(subtask.waitableRep()) << 4 | subtaskState
    });
    return Number(subtask.ensureHandle()) << 4 | subtaskState;
  }
  const CURRENT_TASK_MAY_BLOCK = typeof WebAssembly2 !== "undefined" ? new WebAssembly2.Global({ value: "i32", mutable: true }, 0) : false;
  function _liftFlatU8(ctx) {
    _debugLog("[_liftFlatU8()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) {
        throw new Error("expected at least a single i32 argument");
      }
      val = ctx.params[0];
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    if (ctx.storageLen !== void 0 && ctx.storageLen < 1) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u8 requires 1 byte)`);
    }
    val = new DataView(ctx.memory.buffer).getUint8(ctx.storagePtr, true);
    ctx.storagePtr += 1;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 1;
    }
    return [val, ctx];
  }
  function _liftFlatU16(ctx) {
    _debugLog("[_liftFlatU16()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) {
        throw new Error("expected at least a single i32 argument");
      }
      val = ctx.params[0];
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    if (ctx.storageLen !== void 0 && ctx.storageLen < 2) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u16 requires 2 bytes)`);
    }
    val = new DataView(ctx.memory.buffer).getUint16(ctx.storagePtr, true);
    ctx.storagePtr += 2;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 2;
    }
    const rem = ctx.storagePtr % 2;
    if (rem !== 0) {
      ctx.storagePtr += 2 - rem;
    }
    return [val, ctx];
  }
  function _liftFlatU32(ctx) {
    _debugLog("[_liftFlatU32()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) {
        throw new Error("expected at least a single i34 argument");
      }
      val = ctx.params[0] >>> 0;
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    if (ctx.storageLen !== void 0 && ctx.storageLen < 4) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u32 requires 4 bytes)`);
    }
    val = new DataView(ctx.memory.buffer).getUint32(ctx.storagePtr, true);
    ctx.storagePtr += 4;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 4;
    }
    return [val, ctx];
  }
  function _liftFlatU64(ctx) {
    _debugLog("[_liftFlatU64()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length === 0) {
        throw new Error("expected at least one single i64 argument");
      }
      if (typeof ctx.params[0] !== "bigint") {
        throw new Error("expected bigint");
      }
      val = BigInt.asUintN(64, ctx.params[0]);
      ctx.params = ctx.params.slice(1);
      return [val, ctx];
    }
    if (ctx.storageLen !== void 0 && ctx.storageLen < 8) {
      throw new Error(`insufficient storage ([${ctx.storageLen}] bytes) for lift (u64 requires 8 bytes)`);
    }
    val = new DataView(ctx.memory.buffer).getBigUint64(ctx.storagePtr, true);
    ctx.storagePtr += 8;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 8;
    }
    return [val, ctx];
  }
  function _liftFlatStringUTF8(ctx) {
    _debugLog("[_liftFlatStringUTF8()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) {
        throw new Error("expected at least two u32 arguments");
      }
      let offset = ctx.params[0];
      if (typeof offset === "bigint") {
        offset = Number(offset);
      } else {
        offset >>>= 0;
      }
      if (!Number.isSafeInteger(offset)) {
        throw new Error("invalid offset");
      }
      const len = ctx.params[1];
      if (!Number.isSafeInteger(len)) {
        throw new Error("invalid len");
      }
      val = TEXT_DECODER_UTF8.decode(new DataView(ctx.memory.buffer, offset, len));
      ctx.params = ctx.params.slice(2);
      return [val, ctx];
    }
    const rem = ctx.storagePtr % 4;
    if (rem !== 0) {
      ctx.storagePtr += 4 - rem;
    }
    const dv2 = new DataView(ctx.memory.buffer);
    const start = dv2.getUint32(ctx.storagePtr, true);
    const codeUnits = dv2.getUint32(ctx.storagePtr + 4, true);
    val = TEXT_DECODER_UTF8.decode(new Uint8Array(ctx.memory.buffer, start, codeUnits));
    ctx.storagePtr += 8;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 8;
    }
    return [val, ctx];
  }
  function _liftFlatStringUTF16(ctx) {
    _debugLog("[_liftFlatStringUTF16()] args", { ctx });
    let val;
    if (ctx.useDirectParams) {
      if (ctx.params.length < 2) {
        throw new Error("expected at least two u32 arguments");
      }
      let offset = ctx.params[0];
      if (typeof offset === "bigint") {
        offset = Number(offset);
      } else {
        offset >>>= 0;
      }
      if (!Number.isSafeInteger(offset)) {
        throw new Error("invalid offset");
      }
      const len = ctx.params[1];
      if (!Number.isSafeInteger(len)) {
        throw new Error("invalid len");
      }
      val = utf16Decoder.decode(new DataView(ctx.memory.buffer, offset, len * 2));
      ctx.params = ctx.params.slice(2);
      return [val, ctx];
    }
    const rem = ctx.storagePtr % 4;
    if (rem !== 0) {
      ctx.storagePtr += 4 - rem;
    }
    const dv2 = new DataView(ctx.memory.buffer);
    const start = dv2.getUint32(ctx.storagePtr, true);
    const codeUnits = dv2.getUint32(ctx.storagePtr + 4, true);
    val = utf16Decoder.decode(new DataView(ctx.memory.buffer, start, codeUnits * 2));
    ctx.storagePtr += 8;
    if (ctx.storageLen !== void 0) {
      ctx.storageLen -= 8;
    }
    return [val, ctx];
  }
  function _liftFlatStringAny(ctx) {
    switch (ctx.stringEncoding) {
      case "utf8":
        return _liftFlatStringUTF8(ctx);
      case "utf16":
        return _liftFlatStringUTF16(ctx);
      default:
        throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
    }
  }
  const _liftFlatVariantScratch = new DataView(new ArrayBuffer(8));
  function _liftFlatVariant(meta) {
    const {
      caseMetas,
      variantSize32,
      variantAlign32,
      variantPayloadOffset32,
      variantFlatCount,
      variantPayloadFlatTypes,
      isEnum
    } = meta;
    return function _liftFlatVariantInner(ctx) {
      _debugLog("[_liftFlatVariant()] args", { ctx });
      const origUseParams = ctx.useDirectParams;
      let caseIdx;
      let liftRes;
      const originalPtr = ctx.storagePtr;
      const numCases = caseMetas.length;
      if (caseMetas.length < 256) {
        liftRes = _liftFlatU8(ctx);
      } else if (numCases >= 256 && numCases < 65536) {
        liftRes = _liftFlatU16(ctx);
      } else if (numCases >= 65536 && numCases < 4294967296) {
        liftRes = _liftFlatU32(ctx);
      } else {
        throw new Error(`unsupported number of variant cases [${numCases}]`);
      }
      caseIdx = liftRes[0];
      ctx = liftRes[1];
      const [
        tag,
        liftFn,
        caseSize32,
        caseAlign32,
        caseFlatCount,
        caseFlatTypes
      ] = caseMetas[caseIdx];
      if (variantPayloadOffset32 === void 0) {
        throw new Error("unexpectedly missing payload offset");
      }
      if (originalPtr !== void 0) {
        ctx.storagePtr = originalPtr + variantPayloadOffset32;
      }
      let val;
      if (liftFn === null) {
        val = { tag };
        if (originalPtr !== void 0) {
          ctx.storagePtr = originalPtr + variantSize32;
        }
      } else {
        if (ctx.useDirectParams) {
          if (!variantPayloadFlatTypes || !caseFlatTypes) {
            throw new Error("missing variant flat type metadata during direct-param lift");
          }
          const scratch = _liftFlatVariantScratch;
          for (let i = 0; i < caseFlatTypes.length; i++) {
            const have = variantPayloadFlatTypes[i];
            const want = caseFlatTypes[i];
            if (have === want) {
              continue;
            }
            const val2 = ctx.params[i];
            if (have === "i64" && want === "i32") {
              ctx.params[i] = Number(BigInt.asIntN(32, val2));
            } else if (have === "i64" && want === "f32") {
              scratch.setInt32(0, Number(BigInt.asIntN(32, val2)), true);
              ctx.params[i] = scratch.getFloat32(0, true);
            } else if (have === "i64" && want === "f64") {
              scratch.setBigInt64(0, val2, true);
              ctx.params[i] = scratch.getFloat64(0, true);
            } else if (have === "i32" && want === "f32") {
              scratch.setInt32(0, val2, true);
              ctx.params[i] = scratch.getFloat32(0, true);
            } else {
              throw new Error(`invalid variant payload coercion [${have}] -> [${want}]`);
            }
          }
        }
        const [newVal, newCtx] = liftFn(ctx);
        val = { tag, val: newVal };
        ctx = newCtx;
      }
      if (origUseParams) {
        if (variantFlatCount === void 0 || variantFlatCount === null) {
          _debugLog("[_liftFlatVariant()] variant with unknown flat count", { ctx, meta });
          throw new Error("cannot lift variant with unknown flat count");
        }
        if (caseFlatCount === void 0 || caseFlatCount === null) {
          _debugLog("[_liftFlatVariant()] case with unknown flat count", { ctx, meta, case: meta.caseMetas[caseIdx] });
          throw new Error("cannot lift case with unknown flat count");
        }
        const remainingPayloadParams = variantFlatCount - caseFlatCount - (isEnum ? 0 : 1);
        if (remainingPayloadParams < 0) {
          throw new Error(`invalid variant flat count metadata`);
        }
        if (ctx.params.length < remainingPayloadParams) {
          throw new Error(`expected at least [${remainingPayloadParams}] remaining variant payload params, but got [${ctx.params.length}]`);
        }
        ctx.params = ctx.params.slice(remainingPayloadParams);
      }
      if (ctx.storagePtr !== void 0) {
        const rem = ctx.storagePtr % variantAlign32;
        if (rem !== 0) {
          ctx.storagePtr += variantAlign32 - rem;
        }
      }
      return [val, ctx];
    };
  }
  function _liftFlatList(meta) {
    const { elemLiftFn, elemSize32, elemAlign32, knownLen, typedArray } = meta;
    const listValue = typedArray === void 0 ? (values) => values : (values) => new typedArray(values);
    const readValuesAndReset = (ctx, originalPtr, originalLen, dataPtr, len) => {
      if (dataPtr < 0 || len < 0 || elemSize32 !== 0 && len > Math.floor(((1 << 28) - 1) / elemSize32) || dataPtr > ctx.memory.buffer.byteLength || elemSize32 !== 0 && len > Math.floor((ctx.memory.buffer.byteLength - dataPtr) / elemSize32)) {
        throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      }
      if (dataPtr % elemAlign32 !== 0) {
        throw new TypeError(`list pointer [${dataPtr}] is not aligned to ${elemAlign32}`);
      }
      ctx.storagePtr = dataPtr;
      const val = [];
      for (var i = 0; i < len; i++) {
        const elemPtr = dataPtr + i * elemSize32;
        ctx.storagePtr = elemPtr;
        const [res, nextCtx] = elemLiftFn(ctx);
        val.push(res);
        ctx = nextCtx;
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
      }
      if (originalPtr !== null) {
        ctx.storagePtr = originalPtr;
      }
      if (originalLen !== null) {
        ctx.storageLen = originalLen;
      }
      return [listValue(val), ctx];
    };
    return function _liftFlatListInner(ctx) {
      _debugLog("[_liftFlatList()] args", { ctx });
      let liftResults;
      if (knownLen !== void 0) {
        if (ctx.useDirectParams) {
          _debugLog("memory unexpectedly missing while lifting unknown length list", { ctx });
          liftResults = [listValue(ctx.params.slice(0, knownLen)), ctx];
          ctx.params = ctx.params.slice(knownLen);
        } else {
          if (ctx.memory === null) {
            _debugLog("memory unexpectedly missing while lifting known length list", { knownLen, ctx });
            throw new Error(`memory missing while lifting known length (${knownLen}) list`);
          }
          const originalLen = ctx.storageLen;
          const originalPtr = ctx.storagePtr;
          ctx.storageLen = knownLen * elemSize32;
          liftResults = readValuesAndReset(ctx, null, originalLen, ctx.storagePtr, knownLen);
        }
      } else {
        if (ctx.useDirectParams) {
          const dataPtr = ctx.params[0] >>> 0;
          const len = ctx.params[1];
          ctx.params = ctx.params.slice(2);
          ctx.useDirectParams = false;
          const originalPtr = ctx.storagePtr;
          const originalLen = ctx.storageLen;
          ctx.storageLen = len * elemSize32;
          liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
          ctx.useDirectParams = true;
        } else {
          const originalLen = ctx.storageLen;
          ctx.storageLen = 8;
          const dataPtrLiftRes = _liftFlatU32(ctx);
          const dataPtr = dataPtrLiftRes[0];
          ctx = dataPtrLiftRes[1];
          const lenLiftRes = _liftFlatU32(ctx);
          const len = lenLiftRes[0];
          ctx = lenLiftRes[1];
          const originalPtr = ctx.storagePtr;
          ctx.storagePtr = dataPtr;
          ctx.storageLen = len * elemSize32;
          liftResults = readValuesAndReset(ctx, originalPtr, originalLen, dataPtr, len);
        }
      }
      return liftResults;
    };
  }
  function _liftFlatFlags(meta) {
    const { names, size32, align32, intSizeBytes } = meta;
    return function _liftFlatFlagsInner(ctx) {
      _debugLog("[_liftFlatFlags()] args", { ctx });
      let val = {};
      let liftRes;
      let align;
      switch (intSizeBytes) {
        case 1:
          liftRes = _liftFlatU8(ctx);
          break;
        case 2:
          liftRes = _liftFlatU16(ctx);
          break;
        case 4:
          liftRes = _liftFlatU32(ctx);
          break;
        default:
          throw new Error("invalid flags size");
      }
      let bits = liftRes[0];
      ctx = liftRes[1];
      for (const name of names) {
        val[name] = (bits & 1) === 1;
        bits >>>= 1;
      }
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) {
        ctx.storagePtr += align32 - rem;
      }
      return [val, ctx];
    };
  }
  function _liftFlatResult(meta) {
    const f = _liftFlatVariant(meta);
    return function _liftFlatResultInner(ctx) {
      _debugLog("[_liftFlatResult()] args", { ctx });
      const res = f(ctx);
      if (!("val" in res[0])) {
        res[0].val = void 0;
      }
      return res;
    };
  }
  function _liftFlatBorrow(componentTableIdx, size, memory, vals, storagePtr, storageLen) {
    _debugLog("[_liftFlatBorrow()] args", { size, memory, vals, storagePtr, storageLen });
    throw new Error("flat lift for borrowed resources is not supported!");
  }
  function _lowerFlatU8(ctx) {
    _debugLog("[_lowerFlatU8()] args", ctx);
    if (ctx.vals.length !== 1) {
      throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
    }
    if (!ctx.memory) {
      throw new Error("missing memory for lower");
    }
    new DataView(ctx.memory.buffer).setUint8(ctx.storagePtr, ctx.vals[0]);
    ctx.storagePtr += 1;
  }
  function _lowerFlatU16(ctx) {
    _debugLog("[_lowerFlatU16()] args", { ctx });
    if (!ctx.memory) {
      throw new Error("missing memory for lower");
    }
    if (ctx.vals.length !== 1) {
      throw new Error(`unexpected number [${ctx.vals.length}] of vals (expected 1)`);
    }
    const rem = ctx.storagePtr % 2;
    if (rem !== 0) {
      ctx.storagePtr += 2 - rem;
    }
    new DataView(ctx.memory.buffer).setUint16(ctx.storagePtr, ctx.vals[0], true);
    ctx.storagePtr += 2;
  }
  function _lowerFlatU32(ctx) {
    _debugLog("[_lowerFlatU32()] args", { ctx });
    if (ctx.vals.length !== 1) {
      throw new Error(`expected single value to lower, got [${ctx.vals.length}]`);
    }
    const rem = ctx.storagePtr % 4;
    if (rem !== 0) {
      ctx.storagePtr += 4 - rem;
    }
    new DataView(ctx.memory.buffer).setUint32(ctx.storagePtr, ctx.vals[0], true);
    ctx.storagePtr += 4;
  }
  function _lowerFlatU64(ctx) {
    _debugLog("[_lowerFlatU64()] args", { ctx });
    if (ctx.vals.length !== 1) {
      throw new Error("unexpected number of vals");
    }
    const rem = ctx.storagePtr % 8;
    if (rem !== 0) {
      ctx.storagePtr += 8 - rem;
    }
    new DataView(ctx.memory.buffer).setBigUint64(ctx.storagePtr, ctx.vals[0], true);
    ctx.storagePtr += 8;
  }
  function _lowerFlatStringUTF8(ctx) {
    _debugLog("[_lowerFlatStringUTF8()] args", ctx);
    if (!ctx.realloc) {
      throw new Error("missing realloc during flat string lower");
    }
    const { ptr, len } = _utf8AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
    const view = new DataView(ctx.memory.buffer);
    view.setUint32(ctx.storagePtr, ptr, true);
    view.setUint32(ctx.storagePtr + 4, len, true);
    ctx.storagePtr += 8;
  }
  function _lowerFlatStringUTF16(ctx) {
    _debugLog("[_lowerFlatStringUTF16()] args", { ctx });
    if (!ctx.realloc) {
      throw new Error("missing realloc during flat string lower");
    }
    const { ptr, len } = _utf16AllocateAndEncode(ctx.vals[0], ctx.realloc, ctx.memory);
    const view = new DataView(ctx.memory.buffer);
    view.setUint32(ctx.storagePtr, ptr, true);
    view.setUint32(ctx.storagePtr + 4, len, true);
    ctx.storagePtr += 8;
  }
  function _lowerFlatStringAny(ctx) {
    switch (ctx.stringEncoding) {
      case "utf8":
        return _lowerFlatStringUTF8(ctx);
      case "utf16":
        return _lowerFlatStringUTF16(ctx);
      default:
        throw new Error(`missing/unrecognized/unsupported string encoding [${ctx.stringEncoding}]`);
    }
  }
  function _lowerFlatRecord(meta) {
    const { fieldMetas, size32: recordSize32, align32: recordAlign32 } = meta;
    return function _lowerFlatRecordInner(ctx) {
      _debugLog("[_lowerFlatRecord()] args", { ctx });
      const originalPtr = ctx.storagePtr;
      const r = ctx.vals[0];
      for (const [tag, lowerFn, size32, align32] of fieldMetas) {
        const rem2 = ctx.storagePtr % align32;
        if (rem2 !== 0) {
          ctx.storagePtr += align32 - rem2;
        }
        const fieldPtr = ctx.storagePtr;
        ctx.vals = [r[tag]];
        lowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, fieldPtr + size32);
      }
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + recordSize32);
      const rem = ctx.storagePtr % recordAlign32;
      if (rem !== 0) {
        ctx.storagePtr += recordAlign32 - rem;
      }
    };
  }
  function _lowerFlatVariant(meta) {
    const { variantSize32, variantAlign32, variantPayloadOffset32, caseMetas } = meta;
    let caseLookup = {};
    for (const [idx, meta2] of caseMetas.entries()) {
      let tag = meta2[0];
      caseLookup[tag] = { discriminant: idx, meta: meta2 };
    }
    return function _lowerFlatVariantInner(ctx) {
      _debugLog("[_lowerFlatVariant()] args", { ctx });
      const { tag, val } = ctx.vals[0];
      const variantCase = caseLookup[tag];
      if (!variantCase) {
        throw new Error(`missing tag [${tag}] (valid tags: ${Object.keys(caseLookup)})`);
      }
      const [_tag, lowerFn, caseSize32, caseAlign32, caseFlatCount] = variantCase.meta;
      const originalPtr = ctx.storagePtr;
      ctx.vals = [variantCase.discriminant];
      let discLowerRes;
      if (caseMetas.length < 256) {
        discLowerRes = _lowerFlatU8(ctx);
      } else if (caseMetas.length >= 256 && caseMetas.length < 65536) {
        discLowerRes = _lowerFlatU16(ctx);
      } else if (caseMetas.length >= 65536 && caseMetas.length < 4294967296) {
        discLowerRes = _lowerFlatU32(ctx);
      } else {
        throw new Error(`unsupported number of cases [${caseMetas.length}]`);
      }
      const payloadOffsetPtr = originalPtr + variantPayloadOffset32;
      ctx.storagePtr = payloadOffsetPtr;
      ctx.vals = [val];
      if (lowerFn) {
        lowerFn(ctx);
      }
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + variantSize32);
      const rem = ctx.storagePtr % variantAlign32;
      if (rem !== 0) {
        ctx.storagePtr += variantAlign32 - rem;
      }
    };
  }
  function _lowerFlatList(meta) {
    const {
      elemLowerFn,
      knownLen,
      size32,
      align32,
      elemSize32,
      elemAlign32
    } = meta;
    if (!elemLowerFn) {
      throw new TypeError("missing/invalid element lower fn for list");
    }
    return function _lowerFlatListInner(ctx) {
      _debugLog("[_lowerFlatList()] args", { ctx });
      if (ctx.useDirectParams) {
        if (ctx.params.length < 2) {
          throw new Error("insufficient params left to lower list");
        }
        const storagePtr = ctx.params[0] >>> 0;
        const elemCount = ctx.params[1];
        ctx.params = ctx.params.slice(2);
        const list = ctx.vals[0];
        if (!list) {
          throw new Error("missing direct param value");
        }
        const lowerCtx = {
          storagePtr,
          memory: ctx.memory,
          stringEncoding: ctx.stringEncoding
        };
        for (let idx = 0; idx < list.length; idx++) {
          const elemPtr = storagePtr + idx * elemSize32;
          lowerCtx.storagePtr = elemPtr;
          lowerCtx.vals = list.slice(idx, idx + 1);
          elemLowerFn(lowerCtx);
          lowerCtx.storagePtr = Math.max(lowerCtx.storagePtr, elemPtr + elemSize32);
        }
        ctx.storagePtr = lowerCtx.storagePtr;
        return;
      }
      const elems = ctx.vals[0];
      if (knownLen === void 0) {
        if (!ctx.realloc) {
          throw new Error("missing realloc during flat string lower");
        }
        const dataPtr = ctx.realloc(0, 0, elemAlign32, elemSize32 * elems.length);
        ctx.vals[0] = dataPtr;
        _lowerFlatU32(ctx);
        ctx.vals[0] = elems.length;
        _lowerFlatU32(ctx);
        const origPtr = ctx.storagePtr;
        ctx.storagePtr = dataPtr;
        for (const [idx, elem] of elems.entries()) {
          const elemPtr = dataPtr + idx * elemSize32;
          ctx.storagePtr = elemPtr;
          ctx.vals = [elem];
          elemLowerFn(ctx);
          ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
        }
        ctx.storagePtr = origPtr;
      } else {
        if (elems.length !== knownLen) {
          throw new TypeError(`invalid list input of length [${elems.length}], must be length [${knownLen}]`);
        }
        const originalPtr = ctx.storagePtr;
        for (const [idx, elem] of elems.entries()) {
          const elemPtr = originalPtr + idx * elemSize32;
          ctx.storagePtr = elemPtr;
          ctx.vals = [elem];
          elemLowerFn(ctx);
          ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + elemSize32);
        }
      }
      const totalSizeBytes = elems.length * size32;
      if (ctx.storageLen !== void 0 && totalSizeBytes > ctx.storageLen) {
        throw new Error("not enough storage remaining for list flat lower");
      }
    };
  }
  function _lowerFlatTuple(meta) {
    const { elemLowerMetas, size32: tupleSize32, align32: tupleAlign32 } = meta;
    return function _lowerFlatTupleInner(ctx) {
      _debugLog("[_lowerFlatTuple()] args", { ctx });
      const originalPtr = ctx.storagePtr;
      const tuple = ctx.vals[0];
      for (const [idx, [lowerFn, size32, align32]] of elemLowerMetas.entries()) {
        const rem2 = ctx.storagePtr % align32;
        if (rem2 !== 0) {
          ctx.storagePtr += align32 - rem2;
        }
        const elemPtr = ctx.storagePtr;
        ctx.vals = [tuple[idx]];
        lowerFn(ctx);
        ctx.storagePtr = Math.max(ctx.storagePtr, elemPtr + size32);
      }
      ctx.storagePtr = Math.max(ctx.storagePtr, originalPtr + tupleSize32);
      const rem = ctx.storagePtr % tupleAlign32;
      if (rem !== 0) {
        ctx.storagePtr += tupleAlign32 - rem;
      }
    };
  }
  function _lowerFlatFlags(meta) {
    const { names, size32, align32, intSizeBytes } = meta;
    return function _lowerFlatFlagsInner(ctx) {
      _debugLog("[_lowerFlatFlags()] args", { ctx });
      if (ctx.vals.length !== 1) {
        throw new Error("unexpected number of vals");
      }
      const flagObj = ctx.vals[0];
      let flagValue = 0;
      if (typeof flagObj === "object" && flagObj !== null) {
        for (const [idx, name] of names.entries()) {
          if (flagObj[name] === true) {
            flagValue |= 1 << idx;
          }
        }
      } else if (flagObj !== null && flagObj !== void 0) {
        throw new TypeError("only an object, undefined or null can be converted to flags");
      }
      const rem = ctx.storagePtr % align32;
      if (rem !== 0) {
        ctx.storagePtr += align32 - rem;
      }
      const dv2 = new DataView(ctx.memory.buffer);
      if (intSizeBytes === 1) {
        dv2.setUint8(ctx.storagePtr, flagValue);
      } else if (intSizeBytes === 2) {
        dv2.setUint16(ctx.storagePtr, flagValue, true);
      } else if (intSizeBytes === 4) {
        dv2.setUint32(ctx.storagePtr, flagValue, true);
      } else {
        throw new Error(`unrecognized flag size [${intSizeBytes} bytes]`);
      }
      ctx.storagePtr += intSizeBytes;
    };
  }
  function _lowerFlatEnum(meta) {
    const f = _lowerFlatVariant(meta);
    return function _lowerFlatEnumInner(ctx) {
      _debugLog("[_lowerFlatEnum()] args", { ctx });
      const v = ctx.vals[0];
      const isNotEnumObject = typeof v !== "object" || Object.keys(v).length !== 2 || !("tag" in v);
      if (isNotEnumObject) {
        ctx.vals[0] = { tag: v };
      }
      f(ctx);
    };
  }
  function _lowerFlatOption(meta) {
    const { payloadMaybeNull } = meta;
    const f = _lowerFlatVariant(meta);
    return function _lowerFlatOptionInner(ctx) {
      _debugLog("[_lowerFlatOption()] args", { ctx });
      const v = ctx.vals[0];
      if (v === null || v === void 0) {
        ctx.vals[0] = { tag: "none" };
      } else if (payloadMaybeNull) {
        const isNotOptionObject = typeof v !== "object" || Object.keys(v).length !== 2 || !("tag" in v) || !(v.tag === "some" || v.tag === "none") || !("val" in v);
        if (isNotOptionObject) {
          ctx.vals[0] = { tag: "some", val: v };
        }
      } else {
        ctx.vals[0] = { tag: "some", val: v };
      }
      f(ctx);
    };
  }
  function _lowerFlatResult(meta) {
    const f = _lowerFlatVariant(meta);
    return function _lowerFlatResultInner(ctx) {
      _debugLog("[_lowerFlatResult()] args", { ctx });
      const v = ctx.vals[0];
      const isNotResultObject = typeof v !== "object" || Object.keys(v).length !== 2 || !("tag" in v) || !("ok" === v.tag || "err" === v.tag) || !("val" in v);
      if (isNotResultObject) {
        ctx.vals[0] = { tag: "ok", val: v };
      }
      f(ctx);
    };
  }
  function _lowerFlatOwn(meta) {
    const { lowerFn, componentIdx: componentIdx2, tableIdx } = meta;
    return function _lowerFlatOwnInner(ctx) {
      _debugLog("[_lowerFlatOwn()] args", { ctx });
      const { createFn } = ctx;
      if (ctx.componentIdx !== componentIdx2) {
        throw new Error(`component index mismatch (expected [${componentIdx2}], lift called from [${ctx.componentIdx}])`);
      }
      const obj = ctx.vals[0];
      if (obj === void 0 || obj === null) {
        throw new Error("missing resource");
      }
      const handle = ctx.lowerResource ? ctx.lowerResource(obj, tableIdx) : lowerFn(obj);
      ctx.vals[0] = handle;
      _lowerFlatU32(ctx);
    };
  }
  function _trackHostOperation(operation) {
    const result = operation();
    if (result === null || typeof result !== "object" && typeof result !== "function" || typeof result.then !== "function") {
      return result;
    }
    STORE_ASYNC_STATE.pendingHostOperations++;
    const tracked = Promise.resolve(result).finally(() => {
      STORE_ASYNC_STATE.pendingHostOperations--;
      if (STORE_ASYNC_STATE.pendingHostOperations < 0) {
        throw new Error("negative pending host operation count");
      }
      for (const state of ASYNC_STATE.values()) {
        state.runTickLoop();
      }
      _checkForDeadlock();
    });
    for (const sym of [Symbol.asyncDispose, symbolDispose]) {
      if (typeof sym === "symbol" && typeof result[sym] === "function") {
        tracked[sym] = () => result[sym]();
      }
    }
    return tracked;
  }
  function _guardMayLeave(componentIdx2, fn) {
    return function(...args) {
      _checkMayLeave(componentIdx2);
      return fn.apply(this, args);
    };
  }
  function _recordTrap(componentIdx2, err, convertsRangeErrors = false) {
    if (convertsRangeErrors && err instanceof RangeError) {
      err = new WebAssemblyRuntimeError("out of bounds memory access");
    }
    if (err instanceof WebAssemblyRuntimeError) {
      const idx = componentIdx2 ?? CURRENT_TASK_META.current?.componentIdx;
      if (idx !== void 0 && idx !== null) {
        getOrCreateAsyncState(idx).markTrapped(err);
      }
    }
    return err;
  }
  function _guardTrap(componentIdx2, fn, convertsRangeErrors = false) {
    return function(...args) {
      try {
        return fn.apply(this, args);
      } catch (err) {
        throw _recordTrap(componentIdx2, err, convertsRangeErrors);
      }
    };
  }
  const isNode = typeof process !== "undefined" && process.versions && process.versions.node;
  let _fs;
  async function fetchCompile(url) {
    if (isNode) {
      _fs = _fs || await import("node:fs/promises");
      return WebAssembly2.compile(await _fs.readFile(url));
    }
    return fetch(url).then(WebAssembly2.compileStreaming);
  }
  const symbolCabiDispose = Symbol.for("cabiDispose");
  const symbolRscHandle = Symbol("handle");
  const symbolRscRep = Symbol.for("cabiRep");
  const HANDLE_TABLES = [];
  class ComponentError extends Error {
    constructor(value) {
      const enumerable = typeof value !== "string";
      super(enumerable ? `${String(value)} (see error.payload)` : value);
      Object.defineProperty(this, "payload", { value, enumerable });
    }
  }
  const hasOwnProperty = Object.prototype.hasOwnProperty;
  function getErrorPayload(e) {
    if (e && hasOwnProperty.call(e, "payload")) return e.payload;
    if (e instanceof Error) throw e;
    return e;
  }
  function _suspendingImport(componentIdx2, fn, syncOnly = false, switchesTask = false, convertsRangeErrors = true) {
    return function(...args) {
      _checkMayLeave(componentIdx2);
      const saved = CURRENT_TASK_META[componentIdx2] ?? null;
      const savedTask = saved ? getCurrentTask(saved.componentIdx, saved.taskID)?.task : null;
      const mayBlock = savedTask ? savedTask?.mayBlock() ?? CURRENT_TASK_MAY_BLOCK.value !== 0 : false;
      if (!saved && !mayBlock) {
        throw new WebAssemblyRuntimeError("cannot block a synchronous task before returning");
      }
      if (syncOnly || !mayBlock) {
        let result;
        try {
          result = fn.apply(null, args);
        } catch (err) {
          CURRENT_TASK_META[componentIdx2] = saved;
          if (!switchesTask) {
            CURRENT_TASK_META.current = saved;
          }
          throw _recordTrap(componentIdx2, err, convertsRangeErrors);
        }
        CURRENT_TASK_META[componentIdx2] = saved;
        if (!switchesTask) {
          CURRENT_TASK_META.current = saved;
        }
        if (result !== null && (typeof result === "object" || typeof result === "function") && typeof result.then === "function") {
          Promise.resolve(result).catch(() => {
          });
          throw new WebAssemblyRuntimeError("cannot block a synchronous task before returning");
        }
        return result;
      }
      return (async () => {
        try {
          const result = await fn.apply(null, args);
          getOrCreateAsyncState(componentIdx2).throwIfInterrupted();
          return result;
        } catch (err) {
          throw _recordTrap(componentIdx2, err, convertsRangeErrors);
        } finally {
          CURRENT_TASK_META[componentIdx2] = saved;
          if (!switchesTask) {
            CURRENT_TASK_META.current = saved;
          }
        }
      })();
    };
  }
  if (!getCoreModule) getCoreModule = (name) => fetchCompile(new URL(`./${name}`, import.meta.url));
  const module0 = getCoreModule("yosys.core.wasm");
  const module1 = getCoreModule("yosys.core2.wasm");
  const module2 = getCoreModule("yosys.core3.wasm");
  const module3 = getCoreModule("yosys.core4.wasm");
  const { cli, fs, io, monotonicClock, wallClock } = imports.runtime;
  if (cli === void 0) {
    const err = new Error("unexpectedly undefined instance import 'cli', was 'cli' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (fs === void 0) {
    const err = new Error("unexpectedly undefined instance import 'fs', was 'fs' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (io === void 0) {
    const err = new Error("unexpectedly undefined instance import 'io', was 'io' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (monotonicClock === void 0) {
    const err = new Error("unexpectedly undefined instance import 'monotonicClock', was 'monotonicClock' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (wallClock === void 0) {
    const err = new Error("unexpectedly undefined instance import 'wallClock', was 'wallClock' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  const {
    TerminalInput: TerminalInput2,
    TerminalOutput: TerminalOutput2,
    exit,
    getArguments,
    getEnvironment,
    getStderr,
    getStdin,
    getStdout,
    getTerminalStderr,
    getTerminalStdin,
    getTerminalStdout
  } = cli;
  if (TerminalInput2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'TerminalInput', was 'TerminalInput' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (TerminalOutput2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'TerminalOutput', was 'TerminalOutput' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (exit === void 0) {
    const err = new Error("unexpectedly undefined local import 'exit', was 'exit' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getArguments === void 0) {
    const err = new Error("unexpectedly undefined local import 'getArguments', was 'getArguments' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getEnvironment === void 0) {
    const err = new Error("unexpectedly undefined local import 'getEnvironment', was 'getEnvironment' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getStderr === void 0) {
    const err = new Error("unexpectedly undefined local import 'getStderr', was 'getStderr' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getStdin === void 0) {
    const err = new Error("unexpectedly undefined local import 'getStdin', was 'getStdin' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getStdout === void 0) {
    const err = new Error("unexpectedly undefined local import 'getStdout', was 'getStdout' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getTerminalStderr === void 0) {
    const err = new Error("unexpectedly undefined local import 'getTerminalStderr', was 'getTerminalStderr' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getTerminalStdin === void 0) {
    const err = new Error("unexpectedly undefined local import 'getTerminalStdin', was 'getTerminalStdin' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getTerminalStdout === void 0) {
    const err = new Error("unexpectedly undefined local import 'getTerminalStdout', was 'getTerminalStdout' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  const {
    Descriptor: Descriptor2,
    DirectoryEntryStream: DirectoryEntryStream2,
    filesystemErrorCode,
    getDirectories
  } = fs;
  if (Descriptor2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'Descriptor', was 'Descriptor' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (DirectoryEntryStream2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'DirectoryEntryStream', was 'DirectoryEntryStream' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (filesystemErrorCode === void 0) {
    const err = new Error("unexpectedly undefined local import 'filesystemErrorCode', was 'filesystemErrorCode' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (getDirectories === void 0) {
    const err = new Error("unexpectedly undefined local import 'getDirectories', was 'getDirectories' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  const {
    Error: Error$1,
    InputStream: InputStream2,
    OutputStream: OutputStream2,
    Pollable: Pollable2,
    poll
  } = io;
  if (Error$1 === void 0) {
    const err = new Error("unexpectedly undefined local import 'Error$1', was 'Error' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (InputStream2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'InputStream', was 'InputStream' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (OutputStream2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'OutputStream', was 'OutputStream' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (Pollable2 === void 0) {
    const err = new Error("unexpectedly undefined local import 'Pollable', was 'Pollable' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (poll === void 0) {
    const err = new Error("unexpectedly undefined local import 'poll', was 'poll' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  const {
    now,
    subscribeDuration,
    subscribeInstant
  } = monotonicClock;
  if (now === void 0) {
    const err = new Error("unexpectedly undefined local import 'now', was 'now' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (subscribeDuration === void 0) {
    const err = new Error("unexpectedly undefined local import 'subscribeDuration', was 'subscribeDuration' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  if (subscribeInstant === void 0) {
    const err = new Error("unexpectedly undefined local import 'subscribeInstant', was 'subscribeInstant' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  const { now: now$1 } = wallClock;
  if (now$1 === void 0) {
    const err = new Error("unexpectedly undefined local import 'now$1', was 'now' available at instantiation?");
    console.error("ERROR:", err.toString());
    throw err;
  }
  let gen = (function* _initGenerator() {
    const instanceFlags0 = new WebAssembly2.Global({ value: "i32", mutable: true }, 1);
    INSTANCE_FLAGS.set(0, instanceFlags0);
    let exports0;
    let exports1;
    const _trampoline1 = function() {
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="now"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "now",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => now())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="now"][Instruction::Return]', {
        funcName: "now",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([toUint64(ret)]);
      task.exit();
      return toUint64(ret);
    };
    _trampoline1.fnName = "wasi:clocks/monotonic-clock@0.2.12#now";
    const handleTable3 = [T_FLAG, 0];
    handleTable3._createdReps = /* @__PURE__ */ new Set();
    handleTable3._componentIdx = 0;
    const captureTable3 = /* @__PURE__ */ new Map();
    let captureCnt3 = 0;
    HANDLE_TABLES[3] = handleTable3;
    const handleTable1 = [T_FLAG, 0];
    handleTable1._createdReps = /* @__PURE__ */ new Set();
    handleTable1._componentIdx = 0;
    const captureTable1 = /* @__PURE__ */ new Map();
    let captureCnt1 = 0;
    HANDLE_TABLES[1] = handleTable1;
    const _trampoline6 = function(arg0) {
      var handle1 = arg0;
      var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable3.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(InputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "subscribe",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.subscribe())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      if (!(ret instanceof Pollable2)) {
        throw new TypeError('Resource error: Not a valid "Pollable" resource.');
      }
      var handle3 = ret[symbolRscHandle];
      if (!handle3) {
        const rep3 = ret[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep3, ret);
        handle3 = rscTableCreateOwn(handleTable1, rep3);
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.subscribe"][Instruction::Return]', {
        funcName: "[method]input-stream.subscribe",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle3]);
      task.exit();
      return handle3;
    };
    _trampoline6.fnName = "wasi:io/streams@0.2.12#subscribe";
    const handleTable2 = [T_FLAG, 0];
    handleTable2._createdReps = /* @__PURE__ */ new Set();
    handleTable2._componentIdx = 0;
    const captureTable2 = /* @__PURE__ */ new Map();
    let captureCnt2 = 0;
    HANDLE_TABLES[2] = handleTable2;
    const _trampoline7 = function(arg0) {
      var handle1 = arg0;
      var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable2.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(OutputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.subscribe"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "subscribe",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.subscribe())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      if (!(ret instanceof Pollable2)) {
        throw new TypeError('Resource error: Not a valid "Pollable" resource.');
      }
      var handle3 = ret[symbolRscHandle];
      if (!handle3) {
        const rep3 = ret[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep3, ret);
        handle3 = rscTableCreateOwn(handleTable1, rep3);
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.subscribe"][Instruction::Return]', {
        funcName: "[method]output-stream.subscribe",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle3]);
      task.exit();
      return handle3;
    };
    _trampoline7.fnName = "wasi:io/streams@0.2.12#subscribe";
    const _trampoline8 = function(arg0) {
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-duration"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "subscribeDuration",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => subscribeDuration(BigInt.asUintN(64, BigInt(arg0))))
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      if (!(ret instanceof Pollable2)) {
        throw new TypeError('Resource error: Not a valid "Pollable" resource.');
      }
      var handle0 = ret[symbolRscHandle];
      if (!handle0) {
        const rep2 = ret[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep2, ret);
        handle0 = rscTableCreateOwn(handleTable1, rep2);
      }
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-duration"][Instruction::Return]', {
        funcName: "subscribe-duration",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle0]);
      task.exit();
      return handle0;
    };
    _trampoline8.fnName = "wasi:clocks/monotonic-clock@0.2.12#subscribeDuration";
    const _trampoline9 = function(arg0) {
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-instant"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "subscribeInstant",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => subscribeInstant(BigInt.asUintN(64, BigInt(arg0))))
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      if (!(ret instanceof Pollable2)) {
        throw new TypeError('Resource error: Not a valid "Pollable" resource.');
      }
      var handle0 = ret[symbolRscHandle];
      if (!handle0) {
        const rep2 = ret[symbolRscRep] || ++captureCnt1;
        captureTable1.set(rep2, ret);
        handle0 = rscTableCreateOwn(handleTable1, rep2);
      }
      _debugLog('[iface="wasi:clocks/monotonic-clock@0.2.12", function="subscribe-instant"][Instruction::Return]', {
        funcName: "subscribe-instant",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle0]);
      task.exit();
      return handle0;
    };
    _trampoline9.fnName = "wasi:clocks/monotonic-clock@0.2.12#subscribeInstant";
    const _trampoline11 = function() {
      _debugLog('[iface="wasi:cli/stderr@0.2.12", function="get-stderr"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getStderr",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getStderr())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      if (!(ret instanceof OutputStream2)) {
        throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
      }
      var handle0 = ret[symbolRscHandle];
      if (!handle0) {
        const rep2 = ret[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep2, ret);
        handle0 = rscTableCreateOwn(handleTable2, rep2);
      }
      _debugLog('[iface="wasi:cli/stderr@0.2.12", function="get-stderr"][Instruction::Return]', {
        funcName: "get-stderr",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle0]);
      task.exit();
      return handle0;
    };
    _trampoline11.fnName = "wasi:cli/stderr@0.2.12#getStderr";
    const _trampoline12 = function() {
      _debugLog('[iface="wasi:cli/stdin@0.2.12", function="get-stdin"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getStdin",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getStdin())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      if (!(ret instanceof InputStream2)) {
        throw new TypeError('Resource error: Not a valid "InputStream" resource.');
      }
      var handle0 = ret[symbolRscHandle];
      if (!handle0) {
        const rep2 = ret[symbolRscRep] || ++captureCnt3;
        captureTable3.set(rep2, ret);
        handle0 = rscTableCreateOwn(handleTable3, rep2);
      }
      _debugLog('[iface="wasi:cli/stdin@0.2.12", function="get-stdin"][Instruction::Return]', {
        funcName: "get-stdin",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle0]);
      task.exit();
      return handle0;
    };
    _trampoline12.fnName = "wasi:cli/stdin@0.2.12#getStdin";
    const _trampoline13 = function() {
      _debugLog('[iface="wasi:cli/stdout@0.2.12", function="get-stdout"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getStdout",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getStdout())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      if (!(ret instanceof OutputStream2)) {
        throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
      }
      var handle0 = ret[symbolRscHandle];
      if (!handle0) {
        const rep2 = ret[symbolRscRep] || ++captureCnt2;
        captureTable2.set(rep2, ret);
        handle0 = rscTableCreateOwn(handleTable2, rep2);
      }
      _debugLog('[iface="wasi:cli/stdout@0.2.12", function="get-stdout"][Instruction::Return]', {
        funcName: "get-stdout",
        paramCount: 1,
        async: false,
        postReturn: false
      });
      task.resolve([handle0]);
      task.exit();
      return handle0;
    };
    _trampoline13.fnName = "wasi:cli/stdout@0.2.12#getStdout";
    const _trampoline16 = function(arg0) {
      let variant0;
      switch (arg0) {
        case 0: {
          variant0 = {
            tag: "ok",
            val: void 0
          };
          break;
        }
        case 1: {
          variant0 = {
            tag: "err",
            val: void 0
          };
          break;
        }
        default: {
          throw new TypeError("invalid variant discriminant for expected");
        }
      }
      _debugLog('[iface="wasi:cli/exit@0.2.12", function="exit"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "exit",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => exit(variant0))
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      _debugLog('[iface="wasi:cli/exit@0.2.12", function="exit"][Instruction::Return]', {
        funcName: "exit",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline16.fnName = "wasi:cli/exit@0.2.12#exit";
    let exports2;
    let memory0;
    let realloc0;
    let realloc0Async;
    const handleTable0 = [T_FLAG, 0];
    handleTable0._createdReps = /* @__PURE__ */ new Set();
    handleTable0._componentIdx = 0;
    const captureTable0 = /* @__PURE__ */ new Map();
    let captureCnt0 = 0;
    HANDLE_TABLES[0] = handleTable0;
    const _trampoline17 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable0[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable0.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Error$1.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="filesystem-error-code"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "filesystemErrorCode",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => filesystemErrorCode(rsc0))
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant4 = ret;
      if (variant4 === null || variant4 === void 0) {
        dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
      } else {
        const e = variant4;
        dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
        var val3 = e;
        let enum3;
        switch (val3) {
          case "access": {
            enum3 = 0;
            break;
          }
          case "would-block": {
            enum3 = 1;
            break;
          }
          case "already": {
            enum3 = 2;
            break;
          }
          case "bad-descriptor": {
            enum3 = 3;
            break;
          }
          case "busy": {
            enum3 = 4;
            break;
          }
          case "deadlock": {
            enum3 = 5;
            break;
          }
          case "quota": {
            enum3 = 6;
            break;
          }
          case "exist": {
            enum3 = 7;
            break;
          }
          case "file-too-large": {
            enum3 = 8;
            break;
          }
          case "illegal-byte-sequence": {
            enum3 = 9;
            break;
          }
          case "in-progress": {
            enum3 = 10;
            break;
          }
          case "interrupted": {
            enum3 = 11;
            break;
          }
          case "invalid": {
            enum3 = 12;
            break;
          }
          case "io": {
            enum3 = 13;
            break;
          }
          case "is-directory": {
            enum3 = 14;
            break;
          }
          case "loop": {
            enum3 = 15;
            break;
          }
          case "too-many-links": {
            enum3 = 16;
            break;
          }
          case "message-size": {
            enum3 = 17;
            break;
          }
          case "name-too-long": {
            enum3 = 18;
            break;
          }
          case "no-device": {
            enum3 = 19;
            break;
          }
          case "no-entry": {
            enum3 = 20;
            break;
          }
          case "no-lock": {
            enum3 = 21;
            break;
          }
          case "insufficient-memory": {
            enum3 = 22;
            break;
          }
          case "insufficient-space": {
            enum3 = 23;
            break;
          }
          case "not-directory": {
            enum3 = 24;
            break;
          }
          case "not-empty": {
            enum3 = 25;
            break;
          }
          case "not-recoverable": {
            enum3 = 26;
            break;
          }
          case "unsupported": {
            enum3 = 27;
            break;
          }
          case "no-tty": {
            enum3 = 28;
            break;
          }
          case "no-such-device": {
            enum3 = 29;
            break;
          }
          case "overflow": {
            enum3 = 30;
            break;
          }
          case "not-permitted": {
            enum3 = 31;
            break;
          }
          case "pipe": {
            enum3 = 32;
            break;
          }
          case "read-only": {
            enum3 = 33;
            break;
          }
          case "invalid-seek": {
            enum3 = 34;
            break;
          }
          case "text-file-busy": {
            enum3 = 35;
            break;
          }
          case "cross-device": {
            enum3 = 36;
            break;
          }
          default: {
            if (e instanceof Error) {
              console.error(e);
            }
            throw new TypeError(`"${val3}" is not one of the cases of error-code`);
          }
        }
        dataView(memory0).setInt8((arg1 >>> 0) + 1, enum3, true);
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="filesystem-error-code"][Instruction::Return]', {
        funcName: "filesystem-error-code",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline17.fnName = "wasi:filesystem/types@0.2.12#filesystemErrorCode";
    const handleTable6 = [T_FLAG, 0];
    handleTable6._createdReps = /* @__PURE__ */ new Set();
    handleTable6._componentIdx = 0;
    const captureTable6 = /* @__PURE__ */ new Map();
    let captureCnt6 = 0;
    HANDLE_TABLES[6] = handleTable6;
    const _trampoline18 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.metadata-hash"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "metadataHash",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.metadataHash())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          var { lower: v4_0, upper: v4_1 } = e;
          dataView(memory0).setBigInt64((arg1 >>> 0) + 8, toUint64(v4_0), true);
          dataView(memory0).setBigInt64((arg1 >>> 0) + 16, toUint64(v4_1), true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 8, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.metadata-hash"][Instruction::Return]', {
        funcName: "[method]descriptor.metadata-hash",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline18.fnName = "wasi:filesystem/types@0.2.12#metadataHash";
    const handleTable7 = [T_FLAG, 0];
    handleTable7._createdReps = /* @__PURE__ */ new Set();
    handleTable7._componentIdx = 0;
    const captureTable7 = /* @__PURE__ */ new Map();
    let captureCnt7 = 0;
    HANDLE_TABLES[7] = handleTable7;
    const _trampoline19 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable7[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable7.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(DirectoryEntryStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]directory-entry-stream.read-directory-entry"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "readDirectoryEntry",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.readDirectoryEntry())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant9 = ret;
      switch (variant9.tag) {
        case "ok": {
          const e = variant9.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          var variant7 = e;
          if (variant7 === null || variant7 === void 0) {
            dataView(memory0).setInt8((arg1 >>> 0) + 4, 0, true);
          } else {
            const e2 = variant7;
            dataView(memory0).setInt8((arg1 >>> 0) + 4, 1, true);
            var { type: v4_0, name: v4_1 } = e2;
            var val5 = v4_0;
            let enum5;
            switch (val5) {
              case "unknown": {
                enum5 = 0;
                break;
              }
              case "block-device": {
                enum5 = 1;
                break;
              }
              case "character-device": {
                enum5 = 2;
                break;
              }
              case "directory": {
                enum5 = 3;
                break;
              }
              case "fifo": {
                enum5 = 4;
                break;
              }
              case "symbolic-link": {
                enum5 = 5;
                break;
              }
              case "regular-file": {
                enum5 = 6;
                break;
              }
              case "socket": {
                enum5 = 7;
                break;
              }
              default: {
                if (v4_0 instanceof Error) {
                  console.error(v4_0);
                }
                throw new TypeError(`"${val5}" is not one of the cases of descriptor-type`);
              }
            }
            dataView(memory0).setInt8((arg1 >>> 0) + 8, enum5, true);
            var encodeRes = _utf8AllocateAndEncode(v4_1, realloc0, memory0);
            var ptr6 = encodeRes.ptr;
            var len6 = encodeRes.len;
            dataView(memory0).setUint32((arg1 >>> 0) + 16, len6, true);
            dataView(memory0).setUint32((arg1 >>> 0) + 12, ptr6, true);
          }
          break;
        }
        case "err": {
          const e = variant9.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val8 = e;
          let enum8;
          switch (val8) {
            case "access": {
              enum8 = 0;
              break;
            }
            case "would-block": {
              enum8 = 1;
              break;
            }
            case "already": {
              enum8 = 2;
              break;
            }
            case "bad-descriptor": {
              enum8 = 3;
              break;
            }
            case "busy": {
              enum8 = 4;
              break;
            }
            case "deadlock": {
              enum8 = 5;
              break;
            }
            case "quota": {
              enum8 = 6;
              break;
            }
            case "exist": {
              enum8 = 7;
              break;
            }
            case "file-too-large": {
              enum8 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum8 = 9;
              break;
            }
            case "in-progress": {
              enum8 = 10;
              break;
            }
            case "interrupted": {
              enum8 = 11;
              break;
            }
            case "invalid": {
              enum8 = 12;
              break;
            }
            case "io": {
              enum8 = 13;
              break;
            }
            case "is-directory": {
              enum8 = 14;
              break;
            }
            case "loop": {
              enum8 = 15;
              break;
            }
            case "too-many-links": {
              enum8 = 16;
              break;
            }
            case "message-size": {
              enum8 = 17;
              break;
            }
            case "name-too-long": {
              enum8 = 18;
              break;
            }
            case "no-device": {
              enum8 = 19;
              break;
            }
            case "no-entry": {
              enum8 = 20;
              break;
            }
            case "no-lock": {
              enum8 = 21;
              break;
            }
            case "insufficient-memory": {
              enum8 = 22;
              break;
            }
            case "insufficient-space": {
              enum8 = 23;
              break;
            }
            case "not-directory": {
              enum8 = 24;
              break;
            }
            case "not-empty": {
              enum8 = 25;
              break;
            }
            case "not-recoverable": {
              enum8 = 26;
              break;
            }
            case "unsupported": {
              enum8 = 27;
              break;
            }
            case "no-tty": {
              enum8 = 28;
              break;
            }
            case "no-such-device": {
              enum8 = 29;
              break;
            }
            case "overflow": {
              enum8 = 30;
              break;
            }
            case "not-permitted": {
              enum8 = 31;
              break;
            }
            case "pipe": {
              enum8 = 32;
              break;
            }
            case "read-only": {
              enum8 = 33;
              break;
            }
            case "invalid-seek": {
              enum8 = 34;
              break;
            }
            case "text-file-busy": {
              enum8 = 35;
              break;
            }
            case "cross-device": {
              enum8 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val8}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 4, enum8, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant9, valueType: typeof variant9 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]directory-entry-stream.read-directory-entry"][Instruction::Return]', {
        funcName: "[method]directory-entry-stream.read-directory-entry",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline19.fnName = "wasi:filesystem/types@0.2.12#readDirectoryEntry";
    const _trampoline20 = function(arg0, arg1, arg2, arg3, arg4) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      if ((arg1 & 4294967294) !== 0) {
        throw new TypeError("flags have extraneous bits set");
      }
      var flags3 = {
        symlinkFollow: Boolean(arg1 & 1)
      };
      var ptr4 = arg2 >>> 0 >>> 0;
      var len4 = arg3;
      var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.metadata-hash-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "metadataHashAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet5 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.metadataHashAt(flags3, result4))
        });
        ret = hostRet5 !== null && typeof hostRet5 === "object" && (hostRet5.tag === "ok" || hostRet5.tag === "err") ? hostRet5 : { tag: "ok", val: hostRet5 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant8 = ret;
      switch (variant8.tag) {
        case "ok": {
          const e = variant8.val;
          dataView(memory0).setInt8((arg4 >>> 0) + 0, 0, true);
          var { lower: v6_0, upper: v6_1 } = e;
          dataView(memory0).setBigInt64((arg4 >>> 0) + 8, toUint64(v6_0), true);
          dataView(memory0).setBigInt64((arg4 >>> 0) + 16, toUint64(v6_1), true);
          break;
        }
        case "err": {
          const e = variant8.val;
          dataView(memory0).setInt8((arg4 >>> 0) + 0, 1, true);
          var val7 = e;
          let enum7;
          switch (val7) {
            case "access": {
              enum7 = 0;
              break;
            }
            case "would-block": {
              enum7 = 1;
              break;
            }
            case "already": {
              enum7 = 2;
              break;
            }
            case "bad-descriptor": {
              enum7 = 3;
              break;
            }
            case "busy": {
              enum7 = 4;
              break;
            }
            case "deadlock": {
              enum7 = 5;
              break;
            }
            case "quota": {
              enum7 = 6;
              break;
            }
            case "exist": {
              enum7 = 7;
              break;
            }
            case "file-too-large": {
              enum7 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum7 = 9;
              break;
            }
            case "in-progress": {
              enum7 = 10;
              break;
            }
            case "interrupted": {
              enum7 = 11;
              break;
            }
            case "invalid": {
              enum7 = 12;
              break;
            }
            case "io": {
              enum7 = 13;
              break;
            }
            case "is-directory": {
              enum7 = 14;
              break;
            }
            case "loop": {
              enum7 = 15;
              break;
            }
            case "too-many-links": {
              enum7 = 16;
              break;
            }
            case "message-size": {
              enum7 = 17;
              break;
            }
            case "name-too-long": {
              enum7 = 18;
              break;
            }
            case "no-device": {
              enum7 = 19;
              break;
            }
            case "no-entry": {
              enum7 = 20;
              break;
            }
            case "no-lock": {
              enum7 = 21;
              break;
            }
            case "insufficient-memory": {
              enum7 = 22;
              break;
            }
            case "insufficient-space": {
              enum7 = 23;
              break;
            }
            case "not-directory": {
              enum7 = 24;
              break;
            }
            case "not-empty": {
              enum7 = 25;
              break;
            }
            case "not-recoverable": {
              enum7 = 26;
              break;
            }
            case "unsupported": {
              enum7 = 27;
              break;
            }
            case "no-tty": {
              enum7 = 28;
              break;
            }
            case "no-such-device": {
              enum7 = 29;
              break;
            }
            case "overflow": {
              enum7 = 30;
              break;
            }
            case "not-permitted": {
              enum7 = 31;
              break;
            }
            case "pipe": {
              enum7 = 32;
              break;
            }
            case "read-only": {
              enum7 = 33;
              break;
            }
            case "invalid-seek": {
              enum7 = 34;
              break;
            }
            case "text-file-busy": {
              enum7 = 35;
              break;
            }
            case "cross-device": {
              enum7 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val7}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg4 >>> 0) + 8, enum7, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant8, valueType: typeof variant8 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.metadata-hash-at"][Instruction::Return]', {
        funcName: "[method]descriptor.metadata-hash-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline20.fnName = "wasi:filesystem/types@0.2.12#metadataHashAt";
    const _trampoline21 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.get-flags"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getFlags",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.getFlags())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          let flags4 = 0;
          if (typeof e === "object" && e !== null) {
            flags4 = Boolean(e.read) << 0 | Boolean(e.write) << 1 | Boolean(e.fileIntegritySync) << 2 | Boolean(e.dataIntegritySync) << 3 | Boolean(e.requestedWriteSync) << 4 | Boolean(e.mutateDirectory) << 5;
          } else if (e !== null && e !== void 0) {
            throw new TypeError("only an object, undefined or null can be converted to flags");
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 1, flags4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 1, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.get-flags"][Instruction::Return]', {
        funcName: "[method]descriptor.get-flags",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline21.fnName = "wasi:filesystem/types@0.2.12#getFlags";
    const _trampoline22 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.get-type"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getType",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.getType())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          var val4 = e;
          let enum4;
          switch (val4) {
            case "unknown": {
              enum4 = 0;
              break;
            }
            case "block-device": {
              enum4 = 1;
              break;
            }
            case "character-device": {
              enum4 = 2;
              break;
            }
            case "directory": {
              enum4 = 3;
              break;
            }
            case "fifo": {
              enum4 = 4;
              break;
            }
            case "symbolic-link": {
              enum4 = 5;
              break;
            }
            case "regular-file": {
              enum4 = 6;
              break;
            }
            case "socket": {
              enum4 = 7;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val4}" is not one of the cases of descriptor-type`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 1, enum4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 1, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.get-type"][Instruction::Return]', {
        funcName: "[method]descriptor.get-type",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline22.fnName = "wasi:filesystem/types@0.2.12#getType";
    const _trampoline23 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.append-via-stream"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "appendViaStream",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.appendViaStream())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          if (!(e instanceof OutputStream2)) {
            throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep3 = e[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep3, e);
            handle4 = rscTableCreateOwn(handleTable2, rep3);
          }
          dataView(memory0).setInt32((arg1 >>> 0) + 4, handle4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 4, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.append-via-stream"][Instruction::Return]', {
        funcName: "[method]descriptor.append-via-stream",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline23.fnName = "wasi:filesystem/types@0.2.12#appendViaStream";
    const _trampoline24 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.read-directory"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "readDirectory",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.readDirectory())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          if (!(e instanceof DirectoryEntryStream2)) {
            throw new TypeError('Resource error: Not a valid "DirectoryEntryStream" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep3 = e[symbolRscRep] || ++captureCnt7;
            captureTable7.set(rep3, e);
            handle4 = rscTableCreateOwn(handleTable7, rep3);
          }
          dataView(memory0).setInt32((arg1 >>> 0) + 4, handle4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 4, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.read-directory"][Instruction::Return]', {
        funcName: "[method]descriptor.read-directory",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline24.fnName = "wasi:filesystem/types@0.2.12#readDirectory";
    const _trampoline25 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.create-directory-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "createDirectoryAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.createDirectoryAt(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg3 >>> 0) + 1, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.create-directory-at"][Instruction::Return]', {
        funcName: "[method]descriptor.create-directory-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline25.fnName = "wasi:filesystem/types@0.2.12#createDirectoryAt";
    const _trampoline26 = function(arg0, arg1, arg2, arg3, arg4) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      if ((arg1 & 4294967294) !== 0) {
        throw new TypeError("flags have extraneous bits set");
      }
      var flags3 = {
        symlinkFollow: Boolean(arg1 & 1)
      };
      var ptr4 = arg2 >>> 0 >>> 0;
      var len4 = arg3;
      var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.stat-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "statAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet5 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.statAt(flags3, result4))
        });
        ret = hostRet5 !== null && typeof hostRet5 === "object" && (hostRet5.tag === "ok" || hostRet5.tag === "err") ? hostRet5 : { tag: "ok", val: hostRet5 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant15 = ret;
      switch (variant15.tag) {
        case "ok": {
          const e = variant15.val;
          dataView(memory0).setInt8((arg4 >>> 0) + 0, 0, true);
          var { type: v6_0, linkCount: v6_1, size: v6_2, dataAccessTimestamp: v6_3, dataModificationTimestamp: v6_4, statusChangeTimestamp: v6_5 } = e;
          var val7 = v6_0;
          let enum7;
          switch (val7) {
            case "unknown": {
              enum7 = 0;
              break;
            }
            case "block-device": {
              enum7 = 1;
              break;
            }
            case "character-device": {
              enum7 = 2;
              break;
            }
            case "directory": {
              enum7 = 3;
              break;
            }
            case "fifo": {
              enum7 = 4;
              break;
            }
            case "symbolic-link": {
              enum7 = 5;
              break;
            }
            case "regular-file": {
              enum7 = 6;
              break;
            }
            case "socket": {
              enum7 = 7;
              break;
            }
            default: {
              if (v6_0 instanceof Error) {
                console.error(v6_0);
              }
              throw new TypeError(`"${val7}" is not one of the cases of descriptor-type`);
            }
          }
          dataView(memory0).setInt8((arg4 >>> 0) + 8, enum7, true);
          dataView(memory0).setBigInt64((arg4 >>> 0) + 16, toUint64(v6_1), true);
          dataView(memory0).setBigInt64((arg4 >>> 0) + 24, toUint64(v6_2), true);
          var variant9 = v6_3;
          if (variant9 === null || variant9 === void 0) {
            dataView(memory0).setInt8((arg4 >>> 0) + 32, 0, true);
          } else {
            const e2 = variant9;
            dataView(memory0).setInt8((arg4 >>> 0) + 32, 1, true);
            var { seconds: v8_0, nanoseconds: v8_1 } = e2;
            dataView(memory0).setBigInt64((arg4 >>> 0) + 40, toUint64(v8_0), true);
            dataView(memory0).setInt32((arg4 >>> 0) + 48, toUint32(v8_1), true);
          }
          var variant11 = v6_4;
          if (variant11 === null || variant11 === void 0) {
            dataView(memory0).setInt8((arg4 >>> 0) + 56, 0, true);
          } else {
            const e2 = variant11;
            dataView(memory0).setInt8((arg4 >>> 0) + 56, 1, true);
            var { seconds: v10_0, nanoseconds: v10_1 } = e2;
            dataView(memory0).setBigInt64((arg4 >>> 0) + 64, toUint64(v10_0), true);
            dataView(memory0).setInt32((arg4 >>> 0) + 72, toUint32(v10_1), true);
          }
          var variant13 = v6_5;
          if (variant13 === null || variant13 === void 0) {
            dataView(memory0).setInt8((arg4 >>> 0) + 80, 0, true);
          } else {
            const e2 = variant13;
            dataView(memory0).setInt8((arg4 >>> 0) + 80, 1, true);
            var { seconds: v12_0, nanoseconds: v12_1 } = e2;
            dataView(memory0).setBigInt64((arg4 >>> 0) + 88, toUint64(v12_0), true);
            dataView(memory0).setInt32((arg4 >>> 0) + 96, toUint32(v12_1), true);
          }
          break;
        }
        case "err": {
          const e = variant15.val;
          dataView(memory0).setInt8((arg4 >>> 0) + 0, 1, true);
          var val14 = e;
          let enum14;
          switch (val14) {
            case "access": {
              enum14 = 0;
              break;
            }
            case "would-block": {
              enum14 = 1;
              break;
            }
            case "already": {
              enum14 = 2;
              break;
            }
            case "bad-descriptor": {
              enum14 = 3;
              break;
            }
            case "busy": {
              enum14 = 4;
              break;
            }
            case "deadlock": {
              enum14 = 5;
              break;
            }
            case "quota": {
              enum14 = 6;
              break;
            }
            case "exist": {
              enum14 = 7;
              break;
            }
            case "file-too-large": {
              enum14 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum14 = 9;
              break;
            }
            case "in-progress": {
              enum14 = 10;
              break;
            }
            case "interrupted": {
              enum14 = 11;
              break;
            }
            case "invalid": {
              enum14 = 12;
              break;
            }
            case "io": {
              enum14 = 13;
              break;
            }
            case "is-directory": {
              enum14 = 14;
              break;
            }
            case "loop": {
              enum14 = 15;
              break;
            }
            case "too-many-links": {
              enum14 = 16;
              break;
            }
            case "message-size": {
              enum14 = 17;
              break;
            }
            case "name-too-long": {
              enum14 = 18;
              break;
            }
            case "no-device": {
              enum14 = 19;
              break;
            }
            case "no-entry": {
              enum14 = 20;
              break;
            }
            case "no-lock": {
              enum14 = 21;
              break;
            }
            case "insufficient-memory": {
              enum14 = 22;
              break;
            }
            case "insufficient-space": {
              enum14 = 23;
              break;
            }
            case "not-directory": {
              enum14 = 24;
              break;
            }
            case "not-empty": {
              enum14 = 25;
              break;
            }
            case "not-recoverable": {
              enum14 = 26;
              break;
            }
            case "unsupported": {
              enum14 = 27;
              break;
            }
            case "no-tty": {
              enum14 = 28;
              break;
            }
            case "no-such-device": {
              enum14 = 29;
              break;
            }
            case "overflow": {
              enum14 = 30;
              break;
            }
            case "not-permitted": {
              enum14 = 31;
              break;
            }
            case "pipe": {
              enum14 = 32;
              break;
            }
            case "read-only": {
              enum14 = 33;
              break;
            }
            case "invalid-seek": {
              enum14 = 34;
              break;
            }
            case "text-file-busy": {
              enum14 = 35;
              break;
            }
            case "cross-device": {
              enum14 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val14}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg4 >>> 0) + 8, enum14, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant15, valueType: typeof variant15 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.stat-at"][Instruction::Return]', {
        funcName: "[method]descriptor.stat-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline26.fnName = "wasi:filesystem/types@0.2.12#statAt";
    const _trampoline27 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      if ((arg1 & 4294967294) !== 0) {
        throw new TypeError("flags have extraneous bits set");
      }
      var flags3 = {
        symlinkFollow: Boolean(arg1 & 1)
      };
      var ptr4 = arg2 >>> 0 >>> 0;
      var len4 = arg3;
      var result4 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr4, len4));
      if ((arg4 & 4294967280) !== 0) {
        throw new TypeError("flags have extraneous bits set");
      }
      var flags5 = {
        create: Boolean(arg4 & 1),
        directory: Boolean(arg4 & 2),
        exclusive: Boolean(arg4 & 4),
        truncate: Boolean(arg4 & 8)
      };
      if ((arg5 & 4294967232) !== 0) {
        throw new TypeError("flags have extraneous bits set");
      }
      var flags6 = {
        read: Boolean(arg5 & 1),
        write: Boolean(arg5 & 2),
        fileIntegritySync: Boolean(arg5 & 4),
        dataIntegritySync: Boolean(arg5 & 8),
        requestedWriteSync: Boolean(arg5 & 16),
        mutateDirectory: Boolean(arg5 & 32)
      };
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.open-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "openAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet7 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.openAt(flags3, result4, flags5, flags6))
        });
        ret = hostRet7 !== null && typeof hostRet7 === "object" && (hostRet7.tag === "ok" || hostRet7.tag === "err") ? hostRet7 : { tag: "ok", val: hostRet7 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant10 = ret;
      switch (variant10.tag) {
        case "ok": {
          const e = variant10.val;
          dataView(memory0).setInt8((arg6 >>> 0) + 0, 0, true);
          if (!(e instanceof Descriptor2)) {
            throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
          }
          var handle8 = e[symbolRscHandle];
          if (!handle8) {
            const rep3 = e[symbolRscRep] || ++captureCnt6;
            captureTable6.set(rep3, e);
            handle8 = rscTableCreateOwn(handleTable6, rep3);
          }
          dataView(memory0).setInt32((arg6 >>> 0) + 4, handle8, true);
          break;
        }
        case "err": {
          const e = variant10.val;
          dataView(memory0).setInt8((arg6 >>> 0) + 0, 1, true);
          var val9 = e;
          let enum9;
          switch (val9) {
            case "access": {
              enum9 = 0;
              break;
            }
            case "would-block": {
              enum9 = 1;
              break;
            }
            case "already": {
              enum9 = 2;
              break;
            }
            case "bad-descriptor": {
              enum9 = 3;
              break;
            }
            case "busy": {
              enum9 = 4;
              break;
            }
            case "deadlock": {
              enum9 = 5;
              break;
            }
            case "quota": {
              enum9 = 6;
              break;
            }
            case "exist": {
              enum9 = 7;
              break;
            }
            case "file-too-large": {
              enum9 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum9 = 9;
              break;
            }
            case "in-progress": {
              enum9 = 10;
              break;
            }
            case "interrupted": {
              enum9 = 11;
              break;
            }
            case "invalid": {
              enum9 = 12;
              break;
            }
            case "io": {
              enum9 = 13;
              break;
            }
            case "is-directory": {
              enum9 = 14;
              break;
            }
            case "loop": {
              enum9 = 15;
              break;
            }
            case "too-many-links": {
              enum9 = 16;
              break;
            }
            case "message-size": {
              enum9 = 17;
              break;
            }
            case "name-too-long": {
              enum9 = 18;
              break;
            }
            case "no-device": {
              enum9 = 19;
              break;
            }
            case "no-entry": {
              enum9 = 20;
              break;
            }
            case "no-lock": {
              enum9 = 21;
              break;
            }
            case "insufficient-memory": {
              enum9 = 22;
              break;
            }
            case "insufficient-space": {
              enum9 = 23;
              break;
            }
            case "not-directory": {
              enum9 = 24;
              break;
            }
            case "not-empty": {
              enum9 = 25;
              break;
            }
            case "not-recoverable": {
              enum9 = 26;
              break;
            }
            case "unsupported": {
              enum9 = 27;
              break;
            }
            case "no-tty": {
              enum9 = 28;
              break;
            }
            case "no-such-device": {
              enum9 = 29;
              break;
            }
            case "overflow": {
              enum9 = 30;
              break;
            }
            case "not-permitted": {
              enum9 = 31;
              break;
            }
            case "pipe": {
              enum9 = 32;
              break;
            }
            case "read-only": {
              enum9 = 33;
              break;
            }
            case "invalid-seek": {
              enum9 = 34;
              break;
            }
            case "text-file-busy": {
              enum9 = 35;
              break;
            }
            case "cross-device": {
              enum9 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val9}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg6 >>> 0) + 4, enum9, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant10, valueType: typeof variant10 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.open-at"][Instruction::Return]', {
        funcName: "[method]descriptor.open-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline27.fnName = "wasi:filesystem/types@0.2.12#openAt";
    const _trampoline28 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.readlink-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "readlinkAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.readlinkAt(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant7 = ret;
      switch (variant7.tag) {
        case "ok": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
          var ptr5 = encodeRes.ptr;
          var len5 = encodeRes.len;
          dataView(memory0).setUint32((arg3 >>> 0) + 8, len5, true);
          dataView(memory0).setUint32((arg3 >>> 0) + 4, ptr5, true);
          break;
        }
        case "err": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var val6 = e;
          let enum6;
          switch (val6) {
            case "access": {
              enum6 = 0;
              break;
            }
            case "would-block": {
              enum6 = 1;
              break;
            }
            case "already": {
              enum6 = 2;
              break;
            }
            case "bad-descriptor": {
              enum6 = 3;
              break;
            }
            case "busy": {
              enum6 = 4;
              break;
            }
            case "deadlock": {
              enum6 = 5;
              break;
            }
            case "quota": {
              enum6 = 6;
              break;
            }
            case "exist": {
              enum6 = 7;
              break;
            }
            case "file-too-large": {
              enum6 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum6 = 9;
              break;
            }
            case "in-progress": {
              enum6 = 10;
              break;
            }
            case "interrupted": {
              enum6 = 11;
              break;
            }
            case "invalid": {
              enum6 = 12;
              break;
            }
            case "io": {
              enum6 = 13;
              break;
            }
            case "is-directory": {
              enum6 = 14;
              break;
            }
            case "loop": {
              enum6 = 15;
              break;
            }
            case "too-many-links": {
              enum6 = 16;
              break;
            }
            case "message-size": {
              enum6 = 17;
              break;
            }
            case "name-too-long": {
              enum6 = 18;
              break;
            }
            case "no-device": {
              enum6 = 19;
              break;
            }
            case "no-entry": {
              enum6 = 20;
              break;
            }
            case "no-lock": {
              enum6 = 21;
              break;
            }
            case "insufficient-memory": {
              enum6 = 22;
              break;
            }
            case "insufficient-space": {
              enum6 = 23;
              break;
            }
            case "not-directory": {
              enum6 = 24;
              break;
            }
            case "not-empty": {
              enum6 = 25;
              break;
            }
            case "not-recoverable": {
              enum6 = 26;
              break;
            }
            case "unsupported": {
              enum6 = 27;
              break;
            }
            case "no-tty": {
              enum6 = 28;
              break;
            }
            case "no-such-device": {
              enum6 = 29;
              break;
            }
            case "overflow": {
              enum6 = 30;
              break;
            }
            case "not-permitted": {
              enum6 = 31;
              break;
            }
            case "pipe": {
              enum6 = 32;
              break;
            }
            case "read-only": {
              enum6 = 33;
              break;
            }
            case "invalid-seek": {
              enum6 = 34;
              break;
            }
            case "text-file-busy": {
              enum6 = 35;
              break;
            }
            case "cross-device": {
              enum6 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val6}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg3 >>> 0) + 4, enum6, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.readlink-at"][Instruction::Return]', {
        funcName: "[method]descriptor.readlink-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline28.fnName = "wasi:filesystem/types@0.2.12#readlinkAt";
    const _trampoline29 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.remove-directory-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "removeDirectoryAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.removeDirectoryAt(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg3 >>> 0) + 1, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.remove-directory-at"][Instruction::Return]', {
        funcName: "[method]descriptor.remove-directory-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline29.fnName = "wasi:filesystem/types@0.2.12#removeDirectoryAt";
    const _trampoline30 = function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      var handle5 = arg3;
      var rep6 = handleTable6[(handle5 << 1) + 1] & ~T_FLAG;
      var rsc4 = captureTable6.get(rep6);
      if (!rsc4) {
        rsc4 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc4, symbolRscHandle, { writable: true, value: handle5 });
        Object.defineProperty(rsc4, symbolRscRep, { writable: true, value: rep6 });
      }
      curResourceBorrows.push(rsc4);
      var ptr7 = arg4 >>> 0 >>> 0;
      var len7 = arg5;
      var result7 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr7, len7));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.rename-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "renameAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet8 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.renameAt(result3, rsc4, result7))
        });
        ret = hostRet8 !== null && typeof hostRet8 === "object" && (hostRet8.tag === "ok" || hostRet8.tag === "err") ? hostRet8 : { tag: "ok", val: hostRet8 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant10 = ret;
      switch (variant10.tag) {
        case "ok": {
          const e = variant10.val;
          dataView(memory0).setInt8((arg6 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant10.val;
          dataView(memory0).setInt8((arg6 >>> 0) + 0, 1, true);
          var val9 = e;
          let enum9;
          switch (val9) {
            case "access": {
              enum9 = 0;
              break;
            }
            case "would-block": {
              enum9 = 1;
              break;
            }
            case "already": {
              enum9 = 2;
              break;
            }
            case "bad-descriptor": {
              enum9 = 3;
              break;
            }
            case "busy": {
              enum9 = 4;
              break;
            }
            case "deadlock": {
              enum9 = 5;
              break;
            }
            case "quota": {
              enum9 = 6;
              break;
            }
            case "exist": {
              enum9 = 7;
              break;
            }
            case "file-too-large": {
              enum9 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum9 = 9;
              break;
            }
            case "in-progress": {
              enum9 = 10;
              break;
            }
            case "interrupted": {
              enum9 = 11;
              break;
            }
            case "invalid": {
              enum9 = 12;
              break;
            }
            case "io": {
              enum9 = 13;
              break;
            }
            case "is-directory": {
              enum9 = 14;
              break;
            }
            case "loop": {
              enum9 = 15;
              break;
            }
            case "too-many-links": {
              enum9 = 16;
              break;
            }
            case "message-size": {
              enum9 = 17;
              break;
            }
            case "name-too-long": {
              enum9 = 18;
              break;
            }
            case "no-device": {
              enum9 = 19;
              break;
            }
            case "no-entry": {
              enum9 = 20;
              break;
            }
            case "no-lock": {
              enum9 = 21;
              break;
            }
            case "insufficient-memory": {
              enum9 = 22;
              break;
            }
            case "insufficient-space": {
              enum9 = 23;
              break;
            }
            case "not-directory": {
              enum9 = 24;
              break;
            }
            case "not-empty": {
              enum9 = 25;
              break;
            }
            case "not-recoverable": {
              enum9 = 26;
              break;
            }
            case "unsupported": {
              enum9 = 27;
              break;
            }
            case "no-tty": {
              enum9 = 28;
              break;
            }
            case "no-such-device": {
              enum9 = 29;
              break;
            }
            case "overflow": {
              enum9 = 30;
              break;
            }
            case "not-permitted": {
              enum9 = 31;
              break;
            }
            case "pipe": {
              enum9 = 32;
              break;
            }
            case "read-only": {
              enum9 = 33;
              break;
            }
            case "invalid-seek": {
              enum9 = 34;
              break;
            }
            case "text-file-busy": {
              enum9 = 35;
              break;
            }
            case "cross-device": {
              enum9 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val9}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg6 >>> 0) + 1, enum9, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant10, valueType: typeof variant10 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.rename-at"][Instruction::Return]', {
        funcName: "[method]descriptor.rename-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline30.fnName = "wasi:filesystem/types@0.2.12#renameAt";
    const _trampoline31 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      var result3 = TEXT_DECODER_UTF8.decode(new Uint8Array(memory0.buffer, ptr3, len3));
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.unlink-file-at"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "unlinkFileAt",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.unlinkFileAt(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg3 >>> 0) + 1, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.unlink-file-at"][Instruction::Return]', {
        funcName: "[method]descriptor.unlink-file-at",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline31.fnName = "wasi:filesystem/types@0.2.12#unlinkFileAt";
    const _trampoline32 = function(arg0, arg1, arg2) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.read-via-stream"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "readViaStream",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.readViaStream(BigInt.asUintN(64, BigInt(arg1))))
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 0, true);
          if (!(e instanceof InputStream2)) {
            throw new TypeError('Resource error: Not a valid "InputStream" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep3 = e[symbolRscRep] || ++captureCnt3;
            captureTable3.set(rep3, e);
            handle4 = rscTableCreateOwn(handleTable3, rep3);
          }
          dataView(memory0).setInt32((arg2 >>> 0) + 4, handle4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg2 >>> 0) + 4, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.read-via-stream"][Instruction::Return]', {
        funcName: "[method]descriptor.read-via-stream",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline32.fnName = "wasi:filesystem/types@0.2.12#readViaStream";
    const _trampoline33 = function(arg0, arg1, arg2) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.write-via-stream"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "writeViaStream",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.writeViaStream(BigInt.asUintN(64, BigInt(arg1))))
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 0, true);
          if (!(e instanceof OutputStream2)) {
            throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
          }
          var handle4 = e[symbolRscHandle];
          if (!handle4) {
            const rep3 = e[symbolRscRep] || ++captureCnt2;
            captureTable2.set(rep3, e);
            handle4 = rscTableCreateOwn(handleTable2, rep3);
          }
          dataView(memory0).setInt32((arg2 >>> 0) + 4, handle4, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 1, true);
          var val5 = e;
          let enum5;
          switch (val5) {
            case "access": {
              enum5 = 0;
              break;
            }
            case "would-block": {
              enum5 = 1;
              break;
            }
            case "already": {
              enum5 = 2;
              break;
            }
            case "bad-descriptor": {
              enum5 = 3;
              break;
            }
            case "busy": {
              enum5 = 4;
              break;
            }
            case "deadlock": {
              enum5 = 5;
              break;
            }
            case "quota": {
              enum5 = 6;
              break;
            }
            case "exist": {
              enum5 = 7;
              break;
            }
            case "file-too-large": {
              enum5 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum5 = 9;
              break;
            }
            case "in-progress": {
              enum5 = 10;
              break;
            }
            case "interrupted": {
              enum5 = 11;
              break;
            }
            case "invalid": {
              enum5 = 12;
              break;
            }
            case "io": {
              enum5 = 13;
              break;
            }
            case "is-directory": {
              enum5 = 14;
              break;
            }
            case "loop": {
              enum5 = 15;
              break;
            }
            case "too-many-links": {
              enum5 = 16;
              break;
            }
            case "message-size": {
              enum5 = 17;
              break;
            }
            case "name-too-long": {
              enum5 = 18;
              break;
            }
            case "no-device": {
              enum5 = 19;
              break;
            }
            case "no-entry": {
              enum5 = 20;
              break;
            }
            case "no-lock": {
              enum5 = 21;
              break;
            }
            case "insufficient-memory": {
              enum5 = 22;
              break;
            }
            case "insufficient-space": {
              enum5 = 23;
              break;
            }
            case "not-directory": {
              enum5 = 24;
              break;
            }
            case "not-empty": {
              enum5 = 25;
              break;
            }
            case "not-recoverable": {
              enum5 = 26;
              break;
            }
            case "unsupported": {
              enum5 = 27;
              break;
            }
            case "no-tty": {
              enum5 = 28;
              break;
            }
            case "no-such-device": {
              enum5 = 29;
              break;
            }
            case "overflow": {
              enum5 = 30;
              break;
            }
            case "not-permitted": {
              enum5 = 31;
              break;
            }
            case "pipe": {
              enum5 = 32;
              break;
            }
            case "read-only": {
              enum5 = 33;
              break;
            }
            case "invalid-seek": {
              enum5 = 34;
              break;
            }
            case "text-file-busy": {
              enum5 = 35;
              break;
            }
            case "cross-device": {
              enum5 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val5}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg2 >>> 0) + 4, enum5, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.write-via-stream"][Instruction::Return]', {
        funcName: "[method]descriptor.write-via-stream",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline33.fnName = "wasi:filesystem/types@0.2.12#writeViaStream";
    const _trampoline34 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable6[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable6.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(Descriptor2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.stat"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "stat",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.stat())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant13 = ret;
      switch (variant13.tag) {
        case "ok": {
          const e = variant13.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          var { type: v4_0, linkCount: v4_1, size: v4_2, dataAccessTimestamp: v4_3, dataModificationTimestamp: v4_4, statusChangeTimestamp: v4_5 } = e;
          var val5 = v4_0;
          let enum5;
          switch (val5) {
            case "unknown": {
              enum5 = 0;
              break;
            }
            case "block-device": {
              enum5 = 1;
              break;
            }
            case "character-device": {
              enum5 = 2;
              break;
            }
            case "directory": {
              enum5 = 3;
              break;
            }
            case "fifo": {
              enum5 = 4;
              break;
            }
            case "symbolic-link": {
              enum5 = 5;
              break;
            }
            case "regular-file": {
              enum5 = 6;
              break;
            }
            case "socket": {
              enum5 = 7;
              break;
            }
            default: {
              if (v4_0 instanceof Error) {
                console.error(v4_0);
              }
              throw new TypeError(`"${val5}" is not one of the cases of descriptor-type`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 8, enum5, true);
          dataView(memory0).setBigInt64((arg1 >>> 0) + 16, toUint64(v4_1), true);
          dataView(memory0).setBigInt64((arg1 >>> 0) + 24, toUint64(v4_2), true);
          var variant7 = v4_3;
          if (variant7 === null || variant7 === void 0) {
            dataView(memory0).setInt8((arg1 >>> 0) + 32, 0, true);
          } else {
            const e2 = variant7;
            dataView(memory0).setInt8((arg1 >>> 0) + 32, 1, true);
            var { seconds: v6_0, nanoseconds: v6_1 } = e2;
            dataView(memory0).setBigInt64((arg1 >>> 0) + 40, toUint64(v6_0), true);
            dataView(memory0).setInt32((arg1 >>> 0) + 48, toUint32(v6_1), true);
          }
          var variant9 = v4_4;
          if (variant9 === null || variant9 === void 0) {
            dataView(memory0).setInt8((arg1 >>> 0) + 56, 0, true);
          } else {
            const e2 = variant9;
            dataView(memory0).setInt8((arg1 >>> 0) + 56, 1, true);
            var { seconds: v8_0, nanoseconds: v8_1 } = e2;
            dataView(memory0).setBigInt64((arg1 >>> 0) + 64, toUint64(v8_0), true);
            dataView(memory0).setInt32((arg1 >>> 0) + 72, toUint32(v8_1), true);
          }
          var variant11 = v4_5;
          if (variant11 === null || variant11 === void 0) {
            dataView(memory0).setInt8((arg1 >>> 0) + 80, 0, true);
          } else {
            const e2 = variant11;
            dataView(memory0).setInt8((arg1 >>> 0) + 80, 1, true);
            var { seconds: v10_0, nanoseconds: v10_1 } = e2;
            dataView(memory0).setBigInt64((arg1 >>> 0) + 88, toUint64(v10_0), true);
            dataView(memory0).setInt32((arg1 >>> 0) + 96, toUint32(v10_1), true);
          }
          break;
        }
        case "err": {
          const e = variant13.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var val12 = e;
          let enum12;
          switch (val12) {
            case "access": {
              enum12 = 0;
              break;
            }
            case "would-block": {
              enum12 = 1;
              break;
            }
            case "already": {
              enum12 = 2;
              break;
            }
            case "bad-descriptor": {
              enum12 = 3;
              break;
            }
            case "busy": {
              enum12 = 4;
              break;
            }
            case "deadlock": {
              enum12 = 5;
              break;
            }
            case "quota": {
              enum12 = 6;
              break;
            }
            case "exist": {
              enum12 = 7;
              break;
            }
            case "file-too-large": {
              enum12 = 8;
              break;
            }
            case "illegal-byte-sequence": {
              enum12 = 9;
              break;
            }
            case "in-progress": {
              enum12 = 10;
              break;
            }
            case "interrupted": {
              enum12 = 11;
              break;
            }
            case "invalid": {
              enum12 = 12;
              break;
            }
            case "io": {
              enum12 = 13;
              break;
            }
            case "is-directory": {
              enum12 = 14;
              break;
            }
            case "loop": {
              enum12 = 15;
              break;
            }
            case "too-many-links": {
              enum12 = 16;
              break;
            }
            case "message-size": {
              enum12 = 17;
              break;
            }
            case "name-too-long": {
              enum12 = 18;
              break;
            }
            case "no-device": {
              enum12 = 19;
              break;
            }
            case "no-entry": {
              enum12 = 20;
              break;
            }
            case "no-lock": {
              enum12 = 21;
              break;
            }
            case "insufficient-memory": {
              enum12 = 22;
              break;
            }
            case "insufficient-space": {
              enum12 = 23;
              break;
            }
            case "not-directory": {
              enum12 = 24;
              break;
            }
            case "not-empty": {
              enum12 = 25;
              break;
            }
            case "not-recoverable": {
              enum12 = 26;
              break;
            }
            case "unsupported": {
              enum12 = 27;
              break;
            }
            case "no-tty": {
              enum12 = 28;
              break;
            }
            case "no-such-device": {
              enum12 = 29;
              break;
            }
            case "overflow": {
              enum12 = 30;
              break;
            }
            case "not-permitted": {
              enum12 = 31;
              break;
            }
            case "pipe": {
              enum12 = 32;
              break;
            }
            case "read-only": {
              enum12 = 33;
              break;
            }
            case "invalid-seek": {
              enum12 = 34;
              break;
            }
            case "text-file-busy": {
              enum12 = 35;
              break;
            }
            case "cross-device": {
              enum12 = 36;
              break;
            }
            default: {
              if (e instanceof Error) {
                console.error(e);
              }
              throw new TypeError(`"${val12}" is not one of the cases of error-code`);
            }
          }
          dataView(memory0).setInt8((arg1 >>> 0) + 8, enum12, true);
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant13, valueType: typeof variant13 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:filesystem/types@0.2.12", function="[method]descriptor.stat"][Instruction::Return]', {
        funcName: "[method]descriptor.stat",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline34.fnName = "wasi:filesystem/types@0.2.12#stat";
    const _trampoline35 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable2.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(OutputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.check-write"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "checkWrite",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.checkWrite())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          dataView(memory0).setBigInt64((arg1 >>> 0) + 8, toUint64(e), true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var variant5 = e;
          switch (variant5.tag) {
            case "last-operation-failed": {
              const e2 = variant5.val;
              dataView(memory0).setInt8((arg1 >>> 0) + 8, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle4 = e2[symbolRscHandle];
              if (!handle4) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle4 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg1 >>> 0) + 12, handle4, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg1 >>> 0) + 8, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.check-write"][Instruction::Return]', {
        funcName: "[method]output-stream.check-write",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline35.fnName = "wasi:io/streams@0.2.12#checkWrite";
    const _trampoline36 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable2.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(OutputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      if (ptr3 < 0 || len3 < 0 || len3 > 268435455 || ptr3 > memory0.buffer.byteLength || len3 > Math.floor((memory0.buffer.byteLength - ptr3) / 1)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
      var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.write"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "write",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.write(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant7 = ret;
      switch (variant7.tag) {
        case "ok": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var variant6 = e;
          switch (variant6.tag) {
            case "last-operation-failed": {
              const e2 = variant6.val;
              dataView(memory0).setInt8((arg3 >>> 0) + 4, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle5 = e2[symbolRscHandle];
              if (!handle5) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle5 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg3 >>> 0) + 8, handle5, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg3 >>> 0) + 4, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.write"][Instruction::Return]', {
        funcName: "[method]output-stream.write",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline36.fnName = "wasi:io/streams@0.2.12#write";
    const _trampoline37 = function(arg0, arg1) {
      var handle1 = arg0;
      var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable2.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(OutputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-flush"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "blockingFlush",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.blockingFlush())
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant6 = ret;
      switch (variant6.tag) {
        case "ok": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant6.val;
          dataView(memory0).setInt8((arg1 >>> 0) + 0, 1, true);
          var variant5 = e;
          switch (variant5.tag) {
            case "last-operation-failed": {
              const e2 = variant5.val;
              dataView(memory0).setInt8((arg1 >>> 0) + 4, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle4 = e2[symbolRscHandle];
              if (!handle4) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle4 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg1 >>> 0) + 8, handle4, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg1 >>> 0) + 4, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant5.tag)}\` (received \`${variant5}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant6, valueType: typeof variant6 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-flush"][Instruction::Return]', {
        funcName: "[method]output-stream.blocking-flush",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline37.fnName = "wasi:io/streams@0.2.12#blockingFlush";
    const _trampoline38 = function(arg0, arg1, arg2) {
      var handle1 = arg0;
      var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable3.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(InputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.blocking-read"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "blockingRead",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.blockingRead(BigInt.asUintN(64, BigInt(arg1))))
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant7 = ret;
      switch (variant7.tag) {
        case "ok": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 0, true);
          var val4 = e;
          var len4 = Array.isArray(val4) ? val4.length : val4.byteLength;
          var ptr4 = realloc0(0, 0, 1, len4 * 1);
          let valData4;
          const valLenBytes4 = len4 * 1;
          if (Array.isArray(val4)) {
            let offset = 0;
            const dv4 = new DataView(memory0.buffer);
            for (const v of val4) {
              _requireValidNumericPrimitive.bind(null, "u8")(v);
              dv4.setUint8(ptr4 + offset, v, true);
              offset += 1;
            }
          } else {
            valData4 = new Uint8Array(val4.buffer || val4, val4.byteOffset, valLenBytes4);
            const out4 = new Uint8Array(memory0.buffer, ptr4, valLenBytes4);
            out4.set(valData4);
          }
          dataView(memory0).setUint32((arg2 >>> 0) + 8, len4, true);
          dataView(memory0).setUint32((arg2 >>> 0) + 4, ptr4, true);
          break;
        }
        case "err": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 1, true);
          var variant6 = e;
          switch (variant6.tag) {
            case "last-operation-failed": {
              const e2 = variant6.val;
              dataView(memory0).setInt8((arg2 >>> 0) + 4, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle5 = e2[symbolRscHandle];
              if (!handle5) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle5 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg2 >>> 0) + 8, handle5, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg2 >>> 0) + 4, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.blocking-read"][Instruction::Return]', {
        funcName: "[method]input-stream.blocking-read",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline38.fnName = "wasi:io/streams@0.2.12#blockingRead";
    const _trampoline39 = function(arg0, arg1, arg2) {
      var handle1 = arg0;
      var rep2 = handleTable3[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable3.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(InputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.read"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "read",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet3 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.read(BigInt.asUintN(64, BigInt(arg1))))
        });
        ret = hostRet3 !== null && typeof hostRet3 === "object" && (hostRet3.tag === "ok" || hostRet3.tag === "err") ? hostRet3 : { tag: "ok", val: hostRet3 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant7 = ret;
      switch (variant7.tag) {
        case "ok": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 0, true);
          var val4 = e;
          var len4 = Array.isArray(val4) ? val4.length : val4.byteLength;
          var ptr4 = realloc0(0, 0, 1, len4 * 1);
          let valData4;
          const valLenBytes4 = len4 * 1;
          if (Array.isArray(val4)) {
            let offset = 0;
            const dv4 = new DataView(memory0.buffer);
            for (const v of val4) {
              _requireValidNumericPrimitive.bind(null, "u8")(v);
              dv4.setUint8(ptr4 + offset, v, true);
              offset += 1;
            }
          } else {
            valData4 = new Uint8Array(val4.buffer || val4, val4.byteOffset, valLenBytes4);
            const out4 = new Uint8Array(memory0.buffer, ptr4, valLenBytes4);
            out4.set(valData4);
          }
          dataView(memory0).setUint32((arg2 >>> 0) + 8, len4, true);
          dataView(memory0).setUint32((arg2 >>> 0) + 4, ptr4, true);
          break;
        }
        case "err": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg2 >>> 0) + 0, 1, true);
          var variant6 = e;
          switch (variant6.tag) {
            case "last-operation-failed": {
              const e2 = variant6.val;
              dataView(memory0).setInt8((arg2 >>> 0) + 4, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle5 = e2[symbolRscHandle];
              if (!handle5) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle5 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg2 >>> 0) + 8, handle5, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg2 >>> 0) + 4, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]input-stream.read"][Instruction::Return]', {
        funcName: "[method]input-stream.read",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline39.fnName = "wasi:io/streams@0.2.12#read";
    const _trampoline40 = function(arg0, arg1, arg2, arg3) {
      var handle1 = arg0;
      var rep2 = handleTable2[(handle1 << 1) + 1] & ~T_FLAG;
      var rsc0 = captureTable2.get(rep2);
      if (!rsc0) {
        rsc0 = Object.create(OutputStream2.prototype);
        Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
        Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
      }
      curResourceBorrows.push(rsc0);
      var ptr3 = arg1 >>> 0 >>> 0;
      var len3 = arg2;
      if (ptr3 < 0 || len3 < 0 || len3 > 268435455 || ptr3 > memory0.buffer.byteLength || len3 > Math.floor((memory0.buffer.byteLength - ptr3) / 1)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      if (ptr3 % 1 !== 0) throw new TypeError(`list pointer [${ptr3}] is not aligned to 1`);
      var result3 = new Uint8Array(memory0.buffer.slice(ptr3, ptr3 + len3 * 1));
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-write-and-flush"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "blockingWriteAndFlush",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "result-catch-handler",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        const hostRet4 = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => rsc0.blockingWriteAndFlush(result3))
        });
        ret = hostRet4 !== null && typeof hostRet4 === "object" && (hostRet4.tag === "ok" || hostRet4.tag === "err") ? hostRet4 : { tag: "ok", val: hostRet4 };
      } catch (e) {
        if (getOrCreateAsyncState(0).markTrapped(e)) {
          throw e;
        }
        ret = { tag: "err", val: getErrorPayload(e) };
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var variant7 = ret;
      switch (variant7.tag) {
        case "ok": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 0, true);
          break;
        }
        case "err": {
          const e = variant7.val;
          dataView(memory0).setInt8((arg3 >>> 0) + 0, 1, true);
          var variant6 = e;
          switch (variant6.tag) {
            case "last-operation-failed": {
              const e2 = variant6.val;
              dataView(memory0).setInt8((arg3 >>> 0) + 4, 0, true);
              if (!(e2 instanceof Error$1)) {
                throw new TypeError('Resource error: Not a valid "Error" resource.');
              }
              var handle5 = e2[symbolRscHandle];
              if (!handle5) {
                const rep3 = e2[symbolRscRep] || ++captureCnt0;
                captureTable0.set(rep3, e2);
                handle5 = rscTableCreateOwn(handleTable0, rep3);
              }
              dataView(memory0).setInt32((arg3 >>> 0) + 8, handle5, true);
              break;
            }
            case "closed": {
              dataView(memory0).setInt8((arg3 >>> 0) + 4, 1, true);
              break;
            }
            default: {
              throw new TypeError(`invalid variant tag value \`${JSON.stringify(variant6.tag)}\` (received \`${variant6}\`) specified for \`StreamError\``);
            }
          }
          break;
        }
        default: {
          _debugLog("ERROR: invalid value (expected result as object with 'tag' member)", { value: variant7, valueType: typeof variant7 });
          throw new TypeError("invalid variant specified for result");
        }
      }
      _debugLog('[iface="wasi:io/streams@0.2.12", function="[method]output-stream.blocking-write-and-flush"][Instruction::Return]', {
        funcName: "[method]output-stream.blocking-write-and-flush",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline40.fnName = "wasi:io/streams@0.2.12#blockingWriteAndFlush";
    const _trampoline41 = function(arg0) {
      _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-arguments"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getArguments",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getArguments())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var vec1 = ret;
      var len1 = vec1.length;
      var result1 = realloc0(0, 0, 4, len1 * 8);
      if (result1 < 0 || len1 < 0 || len1 > 33554431 || result1 > memory0.buffer.byteLength || len1 > Math.floor((memory0.buffer.byteLength - result1) / 8)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      for (let i = 0; i < vec1.length; i++) {
        const e = vec1[i];
        const base = result1 + i * 8;
        var encodeRes = _utf8AllocateAndEncode(e, realloc0, memory0);
        var ptr0 = encodeRes.ptr;
        var len0 = encodeRes.len;
        dataView(memory0).setUint32(base + 4, len0, true);
        dataView(memory0).setUint32(base + 0, ptr0, true);
      }
      dataView(memory0).setUint32((arg0 >>> 0) + 4, len1, true);
      dataView(memory0).setUint32((arg0 >>> 0) + 0, result1, true);
      _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-arguments"][Instruction::Return]', {
        funcName: "get-arguments",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline41.fnName = "wasi:cli/environment@0.2.12#getArguments";
    const _trampoline42 = function(arg0) {
      _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-environment"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getEnvironment",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getEnvironment())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var vec3 = ret;
      var len3 = vec3.length;
      var result3 = realloc0(0, 0, 4, len3 * 16);
      if (result3 < 0 || len3 < 0 || len3 > 16777215 || result3 > memory0.buffer.byteLength || len3 > Math.floor((memory0.buffer.byteLength - result3) / 16)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      for (let i = 0; i < vec3.length; i++) {
        const e = vec3[i];
        const base = result3 + i * 16;
        var [tuple0_0, tuple0_1] = e;
        var encodeRes = _utf8AllocateAndEncode(tuple0_0, realloc0, memory0);
        var ptr1 = encodeRes.ptr;
        var len1 = encodeRes.len;
        dataView(memory0).setUint32(base + 4, len1, true);
        dataView(memory0).setUint32(base + 0, ptr1, true);
        var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
        var ptr2 = encodeRes.ptr;
        var len2 = encodeRes.len;
        dataView(memory0).setUint32(base + 12, len2, true);
        dataView(memory0).setUint32(base + 8, ptr2, true);
      }
      dataView(memory0).setUint32((arg0 >>> 0) + 4, len3, true);
      dataView(memory0).setUint32((arg0 >>> 0) + 0, result3, true);
      _debugLog('[iface="wasi:cli/environment@0.2.12", function="get-environment"][Instruction::Return]', {
        funcName: "get-environment",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline42.fnName = "wasi:cli/environment@0.2.12#getEnvironment";
    const _trampoline43 = function(arg0) {
      _debugLog('[iface="wasi:clocks/wall-clock@0.2.12", function="now"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "now$1",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => now$1())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var { seconds: v0_0, nanoseconds: v0_1 } = ret;
      dataView(memory0).setBigInt64((arg0 >>> 0) + 0, toUint64(v0_0), true);
      dataView(memory0).setInt32((arg0 >>> 0) + 8, toUint32(v0_1), true);
      _debugLog('[iface="wasi:clocks/wall-clock@0.2.12", function="now"][Instruction::Return]', {
        funcName: "now",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline43.fnName = "wasi:clocks/wall-clock@0.2.12#now$1";
    const _trampoline44 = function(arg0) {
      _debugLog('[iface="wasi:filesystem/preopens@0.2.12", function="get-directories"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getDirectories",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getDirectories())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var vec3 = ret;
      var len3 = vec3.length;
      var result3 = realloc0(0, 0, 4, len3 * 12);
      if (result3 < 0 || len3 < 0 || len3 > 22369621 || result3 > memory0.buffer.byteLength || len3 > Math.floor((memory0.buffer.byteLength - result3) / 12)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      for (let i = 0; i < vec3.length; i++) {
        const e = vec3[i];
        const base = result3 + i * 12;
        var [tuple0_0, tuple0_1] = e;
        if (!(tuple0_0 instanceof Descriptor2)) {
          throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
        }
        var handle1 = tuple0_0[symbolRscHandle];
        if (!handle1) {
          const rep2 = tuple0_0[symbolRscRep] || ++captureCnt6;
          captureTable6.set(rep2, tuple0_0);
          handle1 = rscTableCreateOwn(handleTable6, rep2);
        }
        dataView(memory0).setInt32(base + 0, handle1, true);
        var encodeRes = _utf8AllocateAndEncode(tuple0_1, realloc0, memory0);
        var ptr2 = encodeRes.ptr;
        var len2 = encodeRes.len;
        dataView(memory0).setUint32(base + 8, len2, true);
        dataView(memory0).setUint32(base + 4, ptr2, true);
      }
      dataView(memory0).setUint32((arg0 >>> 0) + 4, len3, true);
      dataView(memory0).setUint32((arg0 >>> 0) + 0, result3, true);
      _debugLog('[iface="wasi:filesystem/preopens@0.2.12", function="get-directories"][Instruction::Return]', {
        funcName: "get-directories",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline44.fnName = "wasi:filesystem/preopens@0.2.12#getDirectories";
    const _trampoline45 = function(arg0, arg1, arg2) {
      var len3 = arg1;
      var base3 = arg0 >>> 0 >>> 0;
      if (base3 < 0 || len3 < 0 || len3 > 67108863 || base3 > memory0.buffer.byteLength || len3 > Math.floor((memory0.buffer.byteLength - base3) / 4)) throw new WebAssemblyRuntimeError("wasm trap: out of bounds memory access");
      if (base3 % 4 !== 0) throw new TypeError(`list pointer [${base3}] is not aligned to 4`);
      var result3 = [];
      for (let i = 0; i < len3; i++) {
        const base = base3 + i * 4;
        var handle1 = dataView(memory0).getInt32(base + 0, true);
        var rep2 = handleTable1[(handle1 << 1) + 1] & ~T_FLAG;
        var rsc0 = captureTable1.get(rep2);
        if (!rsc0) {
          rsc0 = Object.create(Pollable2.prototype);
          Object.defineProperty(rsc0, symbolRscHandle, { writable: true, value: handle1 });
          Object.defineProperty(rsc0, symbolRscRep, { writable: true, value: rep2 });
        }
        curResourceBorrows.push(rsc0);
        result3.push(rsc0);
      }
      _debugLog('[iface="wasi:io/poll@0.2.12", function="poll"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "poll",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => poll(result3))
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      for (const entry of curResourceBorrows) {
        const rsc = entry.rsc ?? entry;
        if (entry.drop) {
          if (rsc[symbolRscHandle]) {
            entry.drop(rsc[symbolRscHandle]);
          }
        }
        rsc[symbolRscHandle] = void 0;
      }
      curResourceBorrows = [];
      var val4 = ret;
      var len4 = val4.length;
      var ptr4 = realloc0(0, 0, 4, len4 * 4);
      let valData4;
      const valLenBytes4 = len4 * 4;
      if (Array.isArray(val4)) {
        let offset = 0;
        const dv4 = new DataView(memory0.buffer);
        for (const v of val4) {
          _requireValidNumericPrimitive.bind(null, "u32")(v);
          dv4.setUint32(ptr4 + offset, v, true);
          offset += 4;
        }
      } else {
        valData4 = new Uint8Array(val4.buffer || val4, val4.byteOffset, valLenBytes4);
        const out4 = new Uint8Array(memory0.buffer, ptr4, valLenBytes4);
        out4.set(valData4);
      }
      dataView(memory0).setUint32((arg2 >>> 0) + 4, len4, true);
      dataView(memory0).setUint32((arg2 >>> 0) + 0, ptr4, true);
      _debugLog('[iface="wasi:io/poll@0.2.12", function="poll"][Instruction::Return]', {
        funcName: "poll",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline45.fnName = "wasi:io/poll@0.2.12#poll";
    const handleTable4 = [T_FLAG, 0];
    handleTable4._createdReps = /* @__PURE__ */ new Set();
    handleTable4._componentIdx = 0;
    const captureTable4 = /* @__PURE__ */ new Map();
    let captureCnt4 = 0;
    HANDLE_TABLES[4] = handleTable4;
    const _trampoline46 = function(arg0) {
      _debugLog('[iface="wasi:cli/terminal-stdin@0.2.12", function="get-terminal-stdin"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getTerminalStdin",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getTerminalStdin())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var variant1 = ret;
      if (variant1 === null || variant1 === void 0) {
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 0, true);
      } else {
        const e = variant1;
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 1, true);
        if (!(e instanceof TerminalInput2)) {
          throw new TypeError('Resource error: Not a valid "TerminalInput" resource.');
        }
        var handle0 = e[symbolRscHandle];
        if (!handle0) {
          const rep2 = e[symbolRscRep] || ++captureCnt4;
          captureTable4.set(rep2, e);
          handle0 = rscTableCreateOwn(handleTable4, rep2);
        }
        dataView(memory0).setInt32((arg0 >>> 0) + 4, handle0, true);
      }
      _debugLog('[iface="wasi:cli/terminal-stdin@0.2.12", function="get-terminal-stdin"][Instruction::Return]', {
        funcName: "get-terminal-stdin",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline46.fnName = "wasi:cli/terminal-stdin@0.2.12#getTerminalStdin";
    const handleTable5 = [T_FLAG, 0];
    handleTable5._createdReps = /* @__PURE__ */ new Set();
    handleTable5._componentIdx = 0;
    const captureTable5 = /* @__PURE__ */ new Map();
    let captureCnt5 = 0;
    HANDLE_TABLES[5] = handleTable5;
    const _trampoline47 = function(arg0) {
      _debugLog('[iface="wasi:cli/terminal-stdout@0.2.12", function="get-terminal-stdout"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getTerminalStdout",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getTerminalStdout())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var variant1 = ret;
      if (variant1 === null || variant1 === void 0) {
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 0, true);
      } else {
        const e = variant1;
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 1, true);
        if (!(e instanceof TerminalOutput2)) {
          throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
        }
        var handle0 = e[symbolRscHandle];
        if (!handle0) {
          const rep2 = e[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep2, e);
          handle0 = rscTableCreateOwn(handleTable5, rep2);
        }
        dataView(memory0).setInt32((arg0 >>> 0) + 4, handle0, true);
      }
      _debugLog('[iface="wasi:cli/terminal-stdout@0.2.12", function="get-terminal-stdout"][Instruction::Return]', {
        funcName: "get-terminal-stdout",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline47.fnName = "wasi:cli/terminal-stdout@0.2.12#getTerminalStdout";
    const _trampoline48 = function(arg0) {
      _debugLog('[iface="wasi:cli/terminal-stderr@0.2.12", function="get-terminal-stderr"] [Instruction::CallInterface] (sync, @ enter)');
      const hostProvided = true;
      let parentTask;
      let task;
      let subtask;
      const createTask = () => {
        const results = createNewCurrentTask({
          componentIdx: -1,
          isAsync: false,
          entryFnName: "getTerminalStderr",
          getCallbackFn: () => null,
          callbackFnName: null,
          errHandling: "none",
          callingWasmExport: false
        });
        task = results[0];
      };
      taskCreation: {
        parentTask = getCurrentTask(
          0,
          _getGlobalCurrentTaskMeta(0)?.taskID
        )?.task;
        if (!parentTask) {
          createTask();
          break taskCreation;
        }
        createTask();
        if (hostProvided) {
          subtask = parentTask.getLatestSubtask();
          if (!subtask) {
            throw new Error(`Missing subtask (in parent task [${parentTask.id()}]) for host import, has the import been lowered? (ensure asyncImports are set properly)`);
          }
          task.setParentSubtask(subtask);
        }
      }
      const started = task.enterSync();
      let ret;
      try {
        ret = _withGlobalCurrentTaskMeta({
          componentIdx: task.componentIdx(),
          taskID: task.id(),
          fn: () => _trackHostOperation(() => getTerminalStderr())
        });
      } catch (err) {
        _debugLog("[Instruction::CallInterface] error during sync call", {
          taskID: task.id(),
          subtaskID: task.getParentSubtask()?.id(),
          err
        });
        getOrCreateAsyncState(0).markTrapped(err);
        task.setErrored(err);
        task.reject(err);
        task.exit();
        throw err;
      }
      var variant1 = ret;
      if (variant1 === null || variant1 === void 0) {
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 0, true);
      } else {
        const e = variant1;
        dataView(memory0).setInt8((arg0 >>> 0) + 0, 1, true);
        if (!(e instanceof TerminalOutput2)) {
          throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
        }
        var handle0 = e[symbolRscHandle];
        if (!handle0) {
          const rep2 = e[symbolRscRep] || ++captureCnt5;
          captureTable5.set(rep2, e);
          handle0 = rscTableCreateOwn(handleTable5, rep2);
        }
        dataView(memory0).setInt32((arg0 >>> 0) + 4, handle0, true);
      }
      _debugLog('[iface="wasi:cli/terminal-stderr@0.2.12", function="get-terminal-stderr"][Instruction::Return]', {
        funcName: "get-terminal-stderr",
        paramCount: 0,
        async: false,
        postReturn: false
      });
      task.resolve([ret]);
      task.exit();
    };
    _trampoline48.fnName = "wasi:cli/terminal-stderr@0.2.12#getTerminalStderr";
    let exports3;
    let run0212Run;
    function run() {
      const hostProvided = false;
      getOrCreateAsyncState(0).throwIfTrapped();
      const [task, _wasm_call_currentTaskID] = createNewCurrentTask({
        componentIdx: 0,
        isAsync: false,
        isManualAsync: false,
        preserveFutureResult: false,
        entryFnName: "run0212Run",
        getCallbackFn: () => null,
        callbackFnName: null,
        errHandling: "throw-result-err",
        callingWasmExport: true
      });
      task.setCalleeIsAsync(false);
      task.setFuncTypeIsAsync(false);
      task.setReturnResultTypeIdx(4);
      const started = task.enterSync();
      CURRENT_TASK_MAY_BLOCK.value = task.mayBlock() ? 1 : 0;
      if (false) {
        task.setReturnMemoryIdx(null);
        task.setReturnMemory(/* @__PURE__ */ (() => null)());
      }
      return _withGlobalCurrentTaskMeta({
        taskID: task.id(),
        componentIdx: task.componentIdx(),
        fn: () => {
          try {
            _debugLog('[iface="wasi:cli/run@0.2.12", function="run"][Instruction::CallWasm] enter', {
              funcName: "run",
              paramCount: 0,
              async: false,
              postReturn: false
            });
            let ret;
            try {
              ret = _withGlobalCurrentTaskMeta({
                taskID: task.id(),
                componentIdx: task.componentIdx(),
                fn: () => run0212Run()
              });
            } catch (err) {
              _debugLog("[Instruction::CallWasm] error during sync call", {
                taskID: task.id(),
                err
              });
              getOrCreateAsyncState(0).markTrapped(err);
              task.setErrored(err);
              task.reject(err);
              task.exit();
              throw err;
            }
            task.endFirstSlice();
            let variant0;
            switch (ret) {
              case 0: {
                variant0 = {
                  tag: "ok",
                  val: void 0
                };
                break;
              }
              case 1: {
                variant0 = {
                  tag: "err",
                  val: void 0
                };
                break;
              }
              default: {
                throw new TypeError("invalid variant discriminant for expected");
              }
            }
            _debugLog('[iface="wasi:cli/run@0.2.12", function="run"][Instruction::Return]', {
              funcName: "run",
              paramCount: 1,
              async: false,
              postReturn: false
            });
            const retCopy = variant0;
            task.resolve([retCopy.val]);
            task.exit();
            if (typeof retCopy === "object" && retCopy.tag === "err") {
              throw new ComponentError(retCopy.val);
            }
            return retCopy.val;
          } catch (err) {
            if (!task.isResolvedState()) {
              task.setErrored(err);
              task.reject(err);
            }
            if (!task.isExited()) {
              task.exit({ skipExclusiveLockCheck: true });
            }
            throw err;
          }
        }
      });
    }
    function trampoline0(handle) {
      const handleEntry = rscTableRemove(handleTable0, handle);
      if (handleEntry.own) {
        const rsc = captureTable0.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable0.delete(handleEntry.rep);
        } else if (Error$1[symbolCabiDispose]) {
          Error$1[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    let trampoline1 = _trampoline1.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 1,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline1.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatU64],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline1
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 1,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline1.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatU64],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline1
      }
    );
    function trampoline2(handle) {
      const handleEntry = rscTableRemove(handleTable7, handle);
      if (handleEntry.own) {
        const rsc = captureTable7.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable7.delete(handleEntry.rep);
        } else if (DirectoryEntryStream2[symbolCabiDispose]) {
          DirectoryEntryStream2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    function trampoline3(handle) {
      const handleEntry = rscTableRemove(handleTable6, handle);
      if (handleEntry.own) {
        const rsc = captureTable6.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable6.delete(handleEntry.rep);
        } else if (Descriptor2[symbolCabiDispose]) {
          Descriptor2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    function trampoline4(handle) {
      const handleEntry = rscTableRemove(handleTable2, handle);
      if (handleEntry.own) {
        const rsc = captureTable2.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable2.delete(handleEntry.rep);
        } else if (OutputStream2[symbolCabiDispose]) {
          OutputStream2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    function trampoline5(handle) {
      const handleEntry = rscTableRemove(handleTable3, handle);
      if (handleEntry.own) {
        const rsc = captureTable3.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable3.delete(handleEntry.rep);
        } else if (InputStream2[symbolCabiDispose]) {
          InputStream2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    let trampoline6 = _trampoline6.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 6,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline6.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline6
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 6,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline6.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3)],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline6
      }
    );
    let trampoline7 = _trampoline7.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 7,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline7.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline7
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 7,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline7.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline7
      }
    );
    let trampoline8 = _trampoline8.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 8,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline8.manuallyAsync,
        paramLiftFns: [_liftFlatU64],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline8
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 8,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline8.manuallyAsync,
        paramLiftFns: [_liftFlatU64],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline8
      }
    );
    let trampoline9 = _trampoline9.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 9,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline9.manuallyAsync,
        paramLiftFns: [_liftFlatU64],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline9
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 9,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline9.manuallyAsync,
        paramLiftFns: [_liftFlatU64],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 1,
          lowerFn: function lowerImportedOwnedHost_Pollable(obj) {
            if (!(obj instanceof Pollable2)) {
              throw new TypeError('Resource error: Not a valid "Pollable" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt1;
              captureTable1.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable1, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline9
      }
    );
    function trampoline10(handle) {
      const handleEntry = rscTableRemove(handleTable1, handle);
      if (handleEntry.own) {
        const rsc = captureTable1.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable1.delete(handleEntry.rep);
        } else if (Pollable2[symbolCabiDispose]) {
          Pollable2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    let trampoline11 = _trampoline11.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 11,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline11.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 2,
          lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
            if (!(obj instanceof OutputStream2)) {
              throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable2, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline11
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 11,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline11.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 2,
          lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
            if (!(obj instanceof OutputStream2)) {
              throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable2, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline11
      }
    );
    let trampoline12 = _trampoline12.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 12,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline12.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 3,
          lowerFn: function lowerImportedOwnedHost_InputStream(obj) {
            if (!(obj instanceof InputStream2)) {
              throw new TypeError('Resource error: Not a valid "InputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt3;
              captureTable3.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable3, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline12
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 12,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline12.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 3,
          lowerFn: function lowerImportedOwnedHost_InputStream(obj) {
            if (!(obj instanceof InputStream2)) {
              throw new TypeError('Resource error: Not a valid "InputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt3;
              captureTable3.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable3, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline12
      }
    );
    let trampoline13 = _trampoline13.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 13,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline13.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 2,
          lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
            if (!(obj instanceof OutputStream2)) {
              throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable2, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline13
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 13,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline13.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatOwn({
          componentIdx: 0,
          tableIdx: 2,
          lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
            if (!(obj instanceof OutputStream2)) {
              throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
            }
            let handle = obj[symbolRscHandle];
            if (!handle) {
              const rep2 = obj[symbolRscRep] || ++captureCnt2;
              captureTable2.set(rep2, obj);
              handle = rscTableCreateOwn(handleTable2, rep2);
            }
            return handle;
          }
        })],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline13
      }
    );
    function trampoline14(handle) {
      const handleEntry = rscTableRemove(handleTable4, handle);
      if (handleEntry.own) {
        const rsc = captureTable4.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable4.delete(handleEntry.rep);
        } else if (TerminalInput2[symbolCabiDispose]) {
          TerminalInput2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    function trampoline15(handle) {
      const handleEntry = rscTableRemove(handleTable5, handle);
      if (handleEntry.own) {
        const rsc = captureTable5.get(handleEntry.rep);
        if (rsc) {
          if (rsc[symbolDispose]) rsc[symbolDispose]();
          captureTable5.delete(handleEntry.rep);
        } else if (TerminalOutput2[symbolCabiDispose]) {
          TerminalOutput2[symbolCabiDispose](handleEntry.rep);
        }
      }
    }
    let trampoline16 = _trampoline16.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 16,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline16.manuallyAsync,
        paramLiftFns: [
          _liftFlatResult({
            caseMetas: [["ok", null, 0, 0, 0, []], ["err", null, 0, 0, 0, []]],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
            variantPayloadFlatTypes: []
          })
        ],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline16
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 16,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline16.manuallyAsync,
        paramLiftFns: [
          _liftFlatResult({
            caseMetas: [["ok", null, 0, 0, 0, []], ["err", null, 0, 0, 0, []]],
            variantSize32: 1,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 1,
            variantPayloadFlatTypes: []
          })
        ],
        resultLowerFns: [],
        hasResultPointer: false,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: null,
        stringEncoding: "utf8",
        getMemoryFn: () => null,
        getReallocFn: void 0,
        importFn: _trampoline16
      }
    );
    let trampoline17 = _trampoline17.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 17,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline17.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              [
                "some",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline17
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 17,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline17.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 0)],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              [
                "some",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline17
      }
    );
    let trampoline18 = _trampoline18.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 18,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline18.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [["lower", _lowerFlatU64, 8, 8], ["upper", _lowerFlatU64, 8, 8]], size32: 16, align32: 8 }), 24, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                24,
                8,
                8
              ]
            ],
            variantSize32: 24,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline18
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 18,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline18.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [["lower", _lowerFlatU64, 8, 8], ["upper", _lowerFlatU64, 8, 8]], size32: 16, align32: 8 }), 24, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                24,
                8,
                8
              ]
            ],
            variantSize32: 24,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline18
      }
    );
    let trampoline19 = _trampoline19.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 19,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline19.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              [
                "ok",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [[
                      "type",
                      _lowerFlatEnum({
                        caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                        variantSize32: 1,
                        variantAlign32: 1,
                        variantPayloadOffset32: 1,
                        variantFlatCount: 1
                      }),
                      1,
                      1
                    ], ["name", _lowerFlatStringAny, 8, 4]], size32: 12, align32: 4 }), 12, 4, 3]
                  ],
                  variantSize32: 16,
                  variantAlign32: 4,
                  variantPayloadOffset32: 4,
                  variantFlatCount: 4,
                  payloadMaybeNull: false
                }),
                20,
                4,
                4
              ],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                20,
                4,
                4
              ]
            ],
            variantSize32: 20,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 5
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline19
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 19,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline19.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 7)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              [
                "ok",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [[
                      "type",
                      _lowerFlatEnum({
                        caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                        variantSize32: 1,
                        variantAlign32: 1,
                        variantPayloadOffset32: 1,
                        variantFlatCount: 1
                      }),
                      1,
                      1
                    ], ["name", _lowerFlatStringAny, 8, 4]], size32: 12, align32: 4 }), 12, 4, 3]
                  ],
                  variantSize32: 16,
                  variantAlign32: 4,
                  variantPayloadOffset32: 4,
                  variantFlatCount: 4,
                  payloadMaybeNull: false
                }),
                20,
                4,
                4
              ],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                20,
                4,
                4
              ]
            ],
            variantSize32: 20,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 5
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline19
      }
    );
    let trampoline20 = _trampoline20.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 20,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline20.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [["lower", _lowerFlatU64, 8, 8], ["upper", _lowerFlatU64, 8, 8]], size32: 16, align32: 8 }), 24, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                24,
                8,
                8
              ]
            ],
            variantSize32: 24,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline20
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 20,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline20.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [["lower", _lowerFlatU64, 8, 8], ["upper", _lowerFlatU64, 8, 8]], size32: 16, align32: 8 }), 24, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                24,
                8,
                8
              ]
            ],
            variantSize32: 24,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline20
      }
    );
    let trampoline21 = _trampoline21.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 21,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline21.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatFlags({ names: ["read", "write", "fileIntegritySync", "dataIntegritySync", "requestedWriteSync", "mutateDirectory"], size32: 1, align32: 1, intSizeBytes: 1 }), 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline21
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 21,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline21.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatFlags({ names: ["read", "write", "fileIntegritySync", "dataIntegritySync", "requestedWriteSync", "mutateDirectory"], size32: 1, align32: 1, intSizeBytes: 1 }), 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline21
      }
    );
    let trampoline22 = _trampoline22.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 22,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline22.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              [
                "ok",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline22
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 22,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline22.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              [
                "ok",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline22
      }
    );
    let trampoline23 = _trampoline23.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 23,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline23.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 2,
                lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
                  if (!(obj instanceof OutputStream2)) {
                    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt2;
                    captureTable2.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable2, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline23
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 23,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline23.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 2,
                lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
                  if (!(obj instanceof OutputStream2)) {
                    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt2;
                    captureTable2.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable2, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline23
      }
    );
    let trampoline24 = _trampoline24.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 24,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline24.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 7,
                lowerFn: function lowerImportedOwnedHost_DirectoryEntryStream(obj) {
                  if (!(obj instanceof DirectoryEntryStream2)) {
                    throw new TypeError('Resource error: Not a valid "DirectoryEntryStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt7;
                    captureTable7.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable7, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline24
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 24,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline24.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 7,
                lowerFn: function lowerImportedOwnedHost_DirectoryEntryStream(obj) {
                  if (!(obj instanceof DirectoryEntryStream2)) {
                    throw new TypeError('Resource error: Not a valid "DirectoryEntryStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt7;
                    captureTable7.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable7, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline24
      }
    );
    let trampoline25 = _trampoline25.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 25,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline25.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline25
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 25,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline25.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline25
      }
    );
    let trampoline26 = _trampoline26.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 26,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline26.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [[
                "type",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1
              ], ["linkCount", _lowerFlatU64, 8, 8], ["size", _lowerFlatU64, 8, 8], [
                "dataAccessTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "dataModificationTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "statusChangeTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ]], size32: 96, align32: 8 }), 104, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                104,
                8,
                8
              ]
            ],
            variantSize32: 104,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 13
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline26
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 26,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline26.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [[
                "type",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1
              ], ["linkCount", _lowerFlatU64, 8, 8], ["size", _lowerFlatU64, 8, 8], [
                "dataAccessTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "dataModificationTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "statusChangeTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ]], size32: 96, align32: 8 }), 104, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                104,
                8,
                8
              ]
            ],
            variantSize32: 104,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 13
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline26
      }
    );
    let trampoline27 = _trampoline27.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 27,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline27.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny, _liftFlatFlags({ names: ["create", "directory", "exclusive", "truncate"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatFlags({ names: ["read", "write", "fileIntegritySync", "dataIntegritySync", "requestedWriteSync", "mutateDirectory"], size32: 1, align32: 1, intSizeBytes: 1 })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 6,
                lowerFn: function lowerImportedOwnedHost_Descriptor(obj) {
                  if (!(obj instanceof Descriptor2)) {
                    throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt6;
                    captureTable6.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable6, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline27
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 27,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline27.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatFlags({ names: ["symlinkFollow"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatStringAny, _liftFlatFlags({ names: ["create", "directory", "exclusive", "truncate"], size32: 1, align32: 1, intSizeBytes: 1 }), _liftFlatFlags({ names: ["read", "write", "fileIntegritySync", "dataIntegritySync", "requestedWriteSync", "mutateDirectory"], size32: 1, align32: 1, intSizeBytes: 1 })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 6,
                lowerFn: function lowerImportedOwnedHost_Descriptor(obj) {
                  if (!(obj instanceof Descriptor2)) {
                    throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt6;
                    captureTable6.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable6, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline27
      }
    );
    let trampoline28 = _trampoline28.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 28,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline28.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatStringAny, 12, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                12,
                4,
                4
              ]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline28
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 28,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline28.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatStringAny, 12, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                12,
                4,
                4
              ]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline28
      }
    );
    let trampoline29 = _trampoline29.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 29,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline29.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline29
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 29,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline29.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline29
      }
    );
    let trampoline30 = _trampoline30.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 30,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline30.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny, _liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline30
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 30,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline30.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny, _liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline30
      }
    );
    let trampoline31 = _trampoline31.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 31,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline31.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline31
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 31,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline31.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatStringAny],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 2, 1, 1],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                2,
                1,
                1
              ]
            ],
            variantSize32: 2,
            variantAlign32: 1,
            variantPayloadOffset32: 1,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline31
      }
    );
    let trampoline32 = _trampoline32.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 32,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline32.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 3,
                lowerFn: function lowerImportedOwnedHost_InputStream(obj) {
                  if (!(obj instanceof InputStream2)) {
                    throw new TypeError('Resource error: Not a valid "InputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt3;
                    captureTable3.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable3, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline32
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 32,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline32.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 3,
                lowerFn: function lowerImportedOwnedHost_InputStream(obj) {
                  if (!(obj instanceof InputStream2)) {
                    throw new TypeError('Resource error: Not a valid "InputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt3;
                    captureTable3.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable3, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline32
      }
    );
    let trampoline33 = _trampoline33.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 33,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline33.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 2,
                lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
                  if (!(obj instanceof OutputStream2)) {
                    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt2;
                    captureTable2.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable2, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline33
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 33,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline33.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 2,
                lowerFn: function lowerImportedOwnedHost_OutputStream(obj) {
                  if (!(obj instanceof OutputStream2)) {
                    throw new TypeError('Resource error: Not a valid "OutputStream" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt2;
                    captureTable2.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable2, rep2);
                  }
                  return handle;
                }
              }), 8, 4, 4],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                8,
                4,
                4
              ]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline33
      }
    );
    let trampoline34 = _trampoline34.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 34,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline34.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [[
                "type",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1
              ], ["linkCount", _lowerFlatU64, 8, 8], ["size", _lowerFlatU64, 8, 8], [
                "dataAccessTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "dataModificationTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "statusChangeTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ]], size32: 96, align32: 8 }), 104, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                104,
                8,
                8
              ]
            ],
            variantSize32: 104,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 13
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline34
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 34,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline34.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 6)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatRecord({ fieldMetas: [[
                "type",
                _lowerFlatEnum({
                  caseMetas: [["unknown", null, 1, 1, 1], ["block-device", null, 1, 1, 1], ["character-device", null, 1, 1, 1], ["directory", null, 1, 1, 1], ["fifo", null, 1, 1, 1], ["symbolic-link", null, 1, 1, 1], ["regular-file", null, 1, 1, 1], ["socket", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                1,
                1
              ], ["linkCount", _lowerFlatU64, 8, 8], ["size", _lowerFlatU64, 8, 8], [
                "dataAccessTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "dataModificationTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ], [
                "statusChangeTimestamp",
                _lowerFlatOption({
                  caseMetas: [
                    ["none", null, 0, 0, 0],
                    ["some", _lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 }), 16, 8, 2]
                  ],
                  variantSize32: 24,
                  variantAlign32: 8,
                  variantPayloadOffset32: 8,
                  variantFlatCount: 3,
                  payloadMaybeNull: false
                }),
                24,
                8
              ]], size32: 96, align32: 8 }), 104, 8, 8],
              [
                "err",
                _lowerFlatEnum({
                  caseMetas: [["access", null, 1, 1, 1], ["would-block", null, 1, 1, 1], ["already", null, 1, 1, 1], ["bad-descriptor", null, 1, 1, 1], ["busy", null, 1, 1, 1], ["deadlock", null, 1, 1, 1], ["quota", null, 1, 1, 1], ["exist", null, 1, 1, 1], ["file-too-large", null, 1, 1, 1], ["illegal-byte-sequence", null, 1, 1, 1], ["in-progress", null, 1, 1, 1], ["interrupted", null, 1, 1, 1], ["invalid", null, 1, 1, 1], ["io", null, 1, 1, 1], ["is-directory", null, 1, 1, 1], ["loop", null, 1, 1, 1], ["too-many-links", null, 1, 1, 1], ["message-size", null, 1, 1, 1], ["name-too-long", null, 1, 1, 1], ["no-device", null, 1, 1, 1], ["no-entry", null, 1, 1, 1], ["no-lock", null, 1, 1, 1], ["insufficient-memory", null, 1, 1, 1], ["insufficient-space", null, 1, 1, 1], ["not-directory", null, 1, 1, 1], ["not-empty", null, 1, 1, 1], ["not-recoverable", null, 1, 1, 1], ["unsupported", null, 1, 1, 1], ["no-tty", null, 1, 1, 1], ["no-such-device", null, 1, 1, 1], ["overflow", null, 1, 1, 1], ["not-permitted", null, 1, 1, 1], ["pipe", null, 1, 1, 1], ["read-only", null, 1, 1, 1], ["invalid-seek", null, 1, 1, 1], ["text-file-busy", null, 1, 1, 1], ["cross-device", null, 1, 1, 1]],
                  variantSize32: 1,
                  variantAlign32: 1,
                  variantPayloadOffset32: 1,
                  variantFlatCount: 1
                }),
                104,
                8,
                8
              ]
            ],
            variantSize32: 104,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 13
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline34
      }
    );
    let trampoline35 = _trampoline35.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 35,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline35.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatU64, 16, 8, 8],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 16, 8, 8]
            ],
            variantSize32: 16,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline35
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 35,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline35.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatU64, 16, 8, 8],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 16, 8, 8]
            ],
            variantSize32: 16,
            variantAlign32: 8,
            variantPayloadOffset32: 8,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline35
      }
    );
    let trampoline36 = _trampoline36.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 36,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline36.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2), _liftFlatList({
          elemLiftFn: _liftFlatU8,
          elemAlign32: 1,
          elemSize32: 1,
          typedArray: Uint8Array
        })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline36
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 36,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline36.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2), _liftFlatList({
          elemLiftFn: _liftFlatU8,
          elemAlign32: 1,
          elemSize32: 1,
          typedArray: Uint8Array
        })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline36
      }
    );
    let trampoline37 = _trampoline37.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 37,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline37.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline37
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 37,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline37.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2)],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline37
      }
    );
    let trampoline38 = _trampoline38.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 38,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline38.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatList({
                elemLowerFn: _lowerFlatU8,
                elemSize32: 1,
                elemAlign32: 1
              }), 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline38
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 38,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline38.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatList({
                elemLowerFn: _lowerFlatU8,
                elemSize32: 1,
                elemAlign32: 1
              }), 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline38
      }
    );
    let trampoline39 = _trampoline39.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 39,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline39.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatList({
                elemLowerFn: _lowerFlatU8,
                elemSize32: 1,
                elemAlign32: 1
              }), 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline39
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 39,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline39.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 3), _liftFlatU64],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", _lowerFlatList({
                elemLowerFn: _lowerFlatU8,
                elemSize32: 1,
                elemAlign32: 1
              }), 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline39
      }
    );
    let trampoline40 = _trampoline40.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 40,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline40.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2), _liftFlatList({
          elemLiftFn: _liftFlatU8,
          elemAlign32: 1,
          elemSize32: 1,
          typedArray: Uint8Array
        })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline40
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 40,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline40.manuallyAsync,
        paramLiftFns: [_liftFlatBorrow.bind(null, 2), _liftFlatList({
          elemLiftFn: _liftFlatU8,
          elemAlign32: 1,
          elemSize32: 1,
          typedArray: Uint8Array
        })],
        resultLowerFns: [
          _lowerFlatResult({
            caseMetas: [
              ["ok", null, 12, 4, 4],
              ["err", _lowerFlatVariant({
                caseMetas: [["last-operation-failed", _lowerFlatOwn({
                  componentIdx: 0,
                  tableIdx: 0,
                  lowerFn: function lowerImportedOwnedHost_Error$1(obj) {
                    if (!(obj instanceof Error$1)) {
                      throw new TypeError('Resource error: Not a valid "Error$1" resource.');
                    }
                    let handle = obj[symbolRscHandle];
                    if (!handle) {
                      const rep2 = obj[symbolRscRep] || ++captureCnt0;
                      captureTable0.set(rep2, obj);
                      handle = rscTableCreateOwn(handleTable0, rep2);
                    }
                    return handle;
                  }
                }), 4, 4, 1], ["closed", null, 0, 0, 0]],
                variantSize32: 8,
                variantAlign32: 4,
                variantPayloadOffset32: 4,
                variantFlatCount: 2
              }), 12, 4, 4]
            ],
            variantSize32: 12,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 3
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline40
      }
    );
    let trampoline41 = _trampoline41.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 41,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline41.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatStringAny,
          elemSize32: 8,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline41
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 41,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline41.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatStringAny,
          elemSize32: 8,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline41
      }
    );
    let trampoline42 = _trampoline42.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 42,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline42.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4], [_lowerFlatStringAny, 8, 4]], size32: 16, align32: 4 }),
          elemSize32: 16,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline42
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 42,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline42.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatStringAny, 8, 4], [_lowerFlatStringAny, 8, 4]], size32: 16, align32: 4 }),
          elemSize32: 16,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline42
      }
    );
    let trampoline43 = _trampoline43.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 43,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline43.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline43
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 43,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline43.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatRecord({ fieldMetas: [["seconds", _lowerFlatU64, 8, 8], ["nanoseconds", _lowerFlatU32, 4, 4]], size32: 16, align32: 8 })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline43
      }
    );
    let trampoline44 = _trampoline44.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 44,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline44.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
            componentIdx: 0,
            tableIdx: 6,
            lowerFn: function lowerImportedOwnedHost_Descriptor(obj) {
              if (!(obj instanceof Descriptor2)) {
                throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
              }
              let handle = obj[symbolRscHandle];
              if (!handle) {
                const rep2 = obj[symbolRscRep] || ++captureCnt6;
                captureTable6.set(rep2, obj);
                handle = rscTableCreateOwn(handleTable6, rep2);
              }
              return handle;
            }
          }), 4, 4], [_lowerFlatStringAny, 8, 4]], size32: 12, align32: 4 }),
          elemSize32: 12,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline44
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 44,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline44.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatTuple({ elemLowerMetas: [[_lowerFlatOwn({
            componentIdx: 0,
            tableIdx: 6,
            lowerFn: function lowerImportedOwnedHost_Descriptor(obj) {
              if (!(obj instanceof Descriptor2)) {
                throw new TypeError('Resource error: Not a valid "Descriptor" resource.');
              }
              let handle = obj[symbolRscHandle];
              if (!handle) {
                const rep2 = obj[symbolRscRep] || ++captureCnt6;
                captureTable6.set(rep2, obj);
                handle = rscTableCreateOwn(handleTable6, rep2);
              }
              return handle;
            }
          }), 4, 4], [_lowerFlatStringAny, 8, 4]], size32: 12, align32: 4 }),
          elemSize32: 12,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline44
      }
    );
    let trampoline45 = _trampoline45.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 45,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline45.manuallyAsync,
        paramLiftFns: [_liftFlatList({
          elemLiftFn: _liftFlatBorrow.bind(null, 1),
          elemAlign32: 4,
          elemSize32: 4,
          typedArray: void 0
        })],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatU32,
          elemSize32: 4,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline45
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 45,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline45.manuallyAsync,
        paramLiftFns: [_liftFlatList({
          elemLiftFn: _liftFlatBorrow.bind(null, 1),
          elemAlign32: 4,
          elemSize32: 4,
          typedArray: void 0
        })],
        resultLowerFns: [_lowerFlatList({
          elemLowerFn: _lowerFlatU32,
          elemSize32: 4,
          elemAlign32: 4
        })],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: () => realloc0,
        importFn: _trampoline45
      }
    );
    let trampoline46 = _trampoline46.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 46,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline46.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 4,
                lowerFn: function lowerImportedOwnedHost_TerminalInput(obj) {
                  if (!(obj instanceof TerminalInput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalInput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt4;
                    captureTable4.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable4, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline46
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 46,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline46.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 4,
                lowerFn: function lowerImportedOwnedHost_TerminalInput(obj) {
                  if (!(obj instanceof TerminalInput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalInput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt4;
                    captureTable4.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable4, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline46
      }
    );
    let trampoline47 = _trampoline47.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 47,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline47.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 5,
                lowerFn: function lowerImportedOwnedHost_TerminalOutput(obj) {
                  if (!(obj instanceof TerminalOutput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt5;
                    captureTable5.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable5, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline47
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 47,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline47.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 5,
                lowerFn: function lowerImportedOwnedHost_TerminalOutput(obj) {
                  if (!(obj instanceof TerminalOutput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt5;
                    captureTable5.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable5, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline47
      }
    );
    let trampoline48 = _trampoline48.manuallyAsync ? new WebAssembly2.Suspending(_suspendingImport(0, _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 48,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline48.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 5,
                lowerFn: function lowerImportedOwnedHost_TerminalOutput(obj) {
                  if (!(obj instanceof TerminalOutput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt5;
                    captureTable5.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable5, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline48
      }
    ), false, false, false)) : _lowerImportBackwardsCompat.bind(
      null,
      {
        trampolineIdx: 48,
        componentIdx: 0,
        isAsync: false,
        isManualAsync: _trampoline48.manuallyAsync,
        paramLiftFns: [],
        resultLowerFns: [
          _lowerFlatOption({
            caseMetas: [
              ["none", null, 0, 0, 0],
              ["some", _lowerFlatOwn({
                componentIdx: 0,
                tableIdx: 5,
                lowerFn: function lowerImportedOwnedHost_TerminalOutput(obj) {
                  if (!(obj instanceof TerminalOutput2)) {
                    throw new TypeError('Resource error: Not a valid "TerminalOutput" resource.');
                  }
                  let handle = obj[symbolRscHandle];
                  if (!handle) {
                    const rep2 = obj[symbolRscRep] || ++captureCnt5;
                    captureTable5.set(rep2, obj);
                    handle = rscTableCreateOwn(handleTable5, rep2);
                  }
                  return handle;
                }
              }), 4, 4, 1]
            ],
            variantSize32: 8,
            variantAlign32: 4,
            variantPayloadOffset32: 4,
            variantFlatCount: 2,
            payloadMaybeNull: false
          })
        ],
        hasResultPointer: true,
        funcTypeIsAsync: false,
        getCallbackFn: () => null,
        getPostReturnFn: () => null,
        isCancellable: false,
        memoryIdx: 0,
        stringEncoding: "utf8",
        getMemoryFn: () => memory0,
        getReallocFn: void 0,
        importFn: _trampoline48
      }
    );
    Promise.all([module0, module1, module2, module3]).catch(() => {
    });
    ({ exports: exports0 } = yield instantiateCore(yield module2));
    ({ exports: exports1 } = yield instantiateCore(yield module0, {
      wasi_snapshot_preview1: {
        args_get: Object.assign(exports0["0"], { _jcoMaySuspend: false }),
        args_sizes_get: Object.assign(exports0["1"], { _jcoMaySuspend: false }),
        clock_time_get: Object.assign(exports0["4"], { _jcoMaySuspend: false }),
        environ_get: Object.assign(exports0["2"], { _jcoMaySuspend: false }),
        environ_sizes_get: Object.assign(exports0["3"], { _jcoMaySuspend: false }),
        fd_close: Object.assign(exports0["5"], { _jcoMaySuspend: false }),
        fd_fdstat_get: Object.assign(exports0["6"], { _jcoMaySuspend: false }),
        fd_fdstat_set_flags: Object.assign(exports0["7"], { _jcoMaySuspend: false }),
        fd_filestat_get: Object.assign(exports0["8"], { _jcoMaySuspend: false }),
        fd_prestat_dir_name: Object.assign(exports0["10"], { _jcoMaySuspend: false }),
        fd_prestat_get: Object.assign(exports0["9"], { _jcoMaySuspend: false }),
        fd_read: Object.assign(exports0["11"], { _jcoMaySuspend: false }),
        fd_readdir: Object.assign(exports0["12"], { _jcoMaySuspend: false }),
        fd_renumber: Object.assign(exports0["13"], { _jcoMaySuspend: false }),
        fd_seek: Object.assign(exports0["14"], { _jcoMaySuspend: false }),
        fd_write: Object.assign(exports0["15"], { _jcoMaySuspend: false }),
        path_create_directory: Object.assign(exports0["16"], { _jcoMaySuspend: false }),
        path_filestat_get: Object.assign(exports0["17"], { _jcoMaySuspend: false }),
        path_open: Object.assign(exports0["18"], { _jcoMaySuspend: false }),
        path_readlink: Object.assign(exports0["19"], { _jcoMaySuspend: false }),
        path_remove_directory: Object.assign(exports0["20"], { _jcoMaySuspend: false }),
        path_rename: Object.assign(exports0["21"], { _jcoMaySuspend: false }),
        path_unlink_file: Object.assign(exports0["22"], { _jcoMaySuspend: false }),
        poll_oneoff: Object.assign(exports0["23"], { _jcoMaySuspend: false }),
        proc_exit: Object.assign(exports0["24"], { _jcoMaySuspend: false }),
        sched_yield: Object.assign(exports0["25"], { _jcoMaySuspend: false })
      }
    }));
    ({ exports: exports2 } = yield instantiateCore(yield module1, {
      __main_module__: {
        _start: Object.assign(exports1._start, { _jcoMaySuspend: false })
      },
      env: {
        memory: exports1.memory
      },
      "wasi:cli/environment@0.2.12": {
        "get-arguments": Object.assign(exports0["50"], { _jcoMaySuspend: false }),
        "get-environment": Object.assign(exports0["51"], { _jcoMaySuspend: false })
      },
      "wasi:cli/exit@0.2.12": {
        exit: Object.assign(_guardTrap(0, trampoline16, false), { _jcoMaySuspend: false })
      },
      "wasi:cli/stderr@0.2.12": {
        "get-stderr": Object.assign(_guardTrap(0, trampoline11, false), { _jcoMaySuspend: false })
      },
      "wasi:cli/stdin@0.2.12": {
        "get-stdin": Object.assign(_guardTrap(0, trampoline12, false), { _jcoMaySuspend: false })
      },
      "wasi:cli/stdout@0.2.12": {
        "get-stdout": Object.assign(_guardTrap(0, trampoline13, false), { _jcoMaySuspend: false })
      },
      "wasi:cli/terminal-input@0.2.12": {
        "[resource-drop]terminal-input": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline14), true), { _jcoMaySuspend: false })
      },
      "wasi:cli/terminal-output@0.2.12": {
        "[resource-drop]terminal-output": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline15), true), { _jcoMaySuspend: false })
      },
      "wasi:cli/terminal-stderr@0.2.12": {
        "get-terminal-stderr": Object.assign(exports0["57"], { _jcoMaySuspend: false })
      },
      "wasi:cli/terminal-stdin@0.2.12": {
        "get-terminal-stdin": Object.assign(exports0["55"], { _jcoMaySuspend: false })
      },
      "wasi:cli/terminal-stdout@0.2.12": {
        "get-terminal-stdout": Object.assign(exports0["56"], { _jcoMaySuspend: false })
      },
      "wasi:clocks/monotonic-clock@0.2.12": {
        now: Object.assign(_guardTrap(0, trampoline1, false), { _jcoMaySuspend: false }),
        "subscribe-duration": Object.assign(_guardTrap(0, trampoline8, false), { _jcoMaySuspend: false }),
        "subscribe-instant": Object.assign(_guardTrap(0, trampoline9, false), { _jcoMaySuspend: false })
      },
      "wasi:clocks/wall-clock@0.2.12": {
        now: Object.assign(exports0["52"], { _jcoMaySuspend: false })
      },
      "wasi:filesystem/preopens@0.2.6": {
        "get-directories": Object.assign(exports0["53"], { _jcoMaySuspend: false })
      },
      "wasi:filesystem/types@0.2.12": {
        "[method]descriptor.append-via-stream": Object.assign(exports0["32"], { _jcoMaySuspend: false }),
        "[method]descriptor.create-directory-at": Object.assign(exports0["34"], { _jcoMaySuspend: false }),
        "[method]descriptor.get-flags": Object.assign(exports0["30"], { _jcoMaySuspend: false }),
        "[method]descriptor.get-type": Object.assign(exports0["31"], { _jcoMaySuspend: false }),
        "[method]descriptor.metadata-hash": Object.assign(exports0["27"], { _jcoMaySuspend: false }),
        "[method]descriptor.metadata-hash-at": Object.assign(exports0["29"], { _jcoMaySuspend: false }),
        "[method]descriptor.open-at": Object.assign(exports0["36"], { _jcoMaySuspend: false }),
        "[method]descriptor.read-directory": Object.assign(exports0["33"], { _jcoMaySuspend: false }),
        "[method]descriptor.read-via-stream": Object.assign(exports0["41"], { _jcoMaySuspend: false }),
        "[method]descriptor.readlink-at": Object.assign(exports0["37"], { _jcoMaySuspend: false }),
        "[method]descriptor.remove-directory-at": Object.assign(exports0["38"], { _jcoMaySuspend: false }),
        "[method]descriptor.rename-at": Object.assign(exports0["39"], { _jcoMaySuspend: false }),
        "[method]descriptor.stat": Object.assign(exports0["43"], { _jcoMaySuspend: false }),
        "[method]descriptor.stat-at": Object.assign(exports0["35"], { _jcoMaySuspend: false }),
        "[method]descriptor.unlink-file-at": Object.assign(exports0["40"], { _jcoMaySuspend: false }),
        "[method]descriptor.write-via-stream": Object.assign(exports0["42"], { _jcoMaySuspend: false }),
        "[method]directory-entry-stream.read-directory-entry": Object.assign(exports0["28"], { _jcoMaySuspend: false }),
        "[resource-drop]descriptor": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline3), true), { _jcoMaySuspend: false }),
        "[resource-drop]directory-entry-stream": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline2), true), { _jcoMaySuspend: false }),
        "filesystem-error-code": Object.assign(exports0["26"], { _jcoMaySuspend: false })
      },
      "wasi:io/error@0.2.12": {
        "[resource-drop]error": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline0), true), { _jcoMaySuspend: false })
      },
      "wasi:io/poll@0.2.12": {
        "[resource-drop]pollable": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline10), true), { _jcoMaySuspend: false }),
        poll: Object.assign(exports0["54"], { _jcoMaySuspend: false })
      },
      "wasi:io/streams@0.2.12": {
        "[method]input-stream.blocking-read": Object.assign(exports0["47"], { _jcoMaySuspend: false }),
        "[method]input-stream.read": Object.assign(exports0["48"], { _jcoMaySuspend: false }),
        "[method]input-stream.subscribe": Object.assign(_guardTrap(0, trampoline6, false), { _jcoMaySuspend: false }),
        "[method]output-stream.blocking-flush": Object.assign(exports0["46"], { _jcoMaySuspend: false }),
        "[method]output-stream.blocking-write-and-flush": Object.assign(exports0["49"], { _jcoMaySuspend: false }),
        "[method]output-stream.check-write": Object.assign(exports0["44"], { _jcoMaySuspend: false }),
        "[method]output-stream.subscribe": Object.assign(_guardTrap(0, trampoline7, false), { _jcoMaySuspend: false }),
        "[method]output-stream.write": Object.assign(exports0["45"], { _jcoMaySuspend: false }),
        "[resource-drop]input-stream": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline5), true), { _jcoMaySuspend: false }),
        "[resource-drop]output-stream": Object.assign(_guardTrap(0, _guardMayLeave(0, trampoline4), true), { _jcoMaySuspend: false })
      }
    }));
    memory0 = exports1.memory;
    realloc0 = (oldPtr, oldSize, align, newSize) => exports2.cabi_import_realloc(oldPtr, oldSize, align, newSize) >>> 0;
    try {
      const realloc0Promising = WebAssembly2.promising(exports2.cabi_import_realloc);
      realloc0Async = async (oldPtr, oldSize, align, newSize) => await realloc0Promising(oldPtr, oldSize, align, newSize) >>> 0;
    } catch (err) {
      realloc0Async = realloc0;
    }
    ({ exports: exports3 } = yield instantiateCore(yield module3, {
      actual: {
        "0": Object.assign(exports2.args_get, { _jcoMaySuspend: false }),
        "1": Object.assign(exports2.args_sizes_get, { _jcoMaySuspend: false }),
        "10": Object.assign(exports2.fd_prestat_dir_name, { _jcoMaySuspend: false }),
        "11": Object.assign(exports2.fd_read, { _jcoMaySuspend: false }),
        "12": Object.assign(exports2.fd_readdir, { _jcoMaySuspend: false }),
        "13": Object.assign(exports2.fd_renumber, { _jcoMaySuspend: false }),
        "14": Object.assign(exports2.fd_seek, { _jcoMaySuspend: false }),
        "15": Object.assign(exports2.fd_write, { _jcoMaySuspend: false }),
        "16": Object.assign(exports2.path_create_directory, { _jcoMaySuspend: false }),
        "17": Object.assign(exports2.path_filestat_get, { _jcoMaySuspend: false }),
        "18": Object.assign(exports2.path_open, { _jcoMaySuspend: false }),
        "19": Object.assign(exports2.path_readlink, { _jcoMaySuspend: false }),
        "2": Object.assign(exports2.environ_get, { _jcoMaySuspend: false }),
        "20": Object.assign(exports2.path_remove_directory, { _jcoMaySuspend: false }),
        "21": Object.assign(exports2.path_rename, { _jcoMaySuspend: false }),
        "22": Object.assign(exports2.path_unlink_file, { _jcoMaySuspend: false }),
        "23": Object.assign(exports2.poll_oneoff, { _jcoMaySuspend: false }),
        "24": Object.assign(exports2.proc_exit, { _jcoMaySuspend: false }),
        "25": Object.assign(exports2.sched_yield, { _jcoMaySuspend: false }),
        "26": Object.assign(_guardTrap(0, trampoline17, false), { _jcoMaySuspend: false }),
        "27": Object.assign(_guardTrap(0, trampoline18, false), { _jcoMaySuspend: false }),
        "28": Object.assign(_guardTrap(0, trampoline19, false), { _jcoMaySuspend: false }),
        "29": Object.assign(_guardTrap(0, trampoline20, false), { _jcoMaySuspend: false }),
        "3": Object.assign(exports2.environ_sizes_get, { _jcoMaySuspend: false }),
        "30": Object.assign(_guardTrap(0, trampoline21, false), { _jcoMaySuspend: false }),
        "31": Object.assign(_guardTrap(0, trampoline22, false), { _jcoMaySuspend: false }),
        "32": Object.assign(_guardTrap(0, trampoline23, false), { _jcoMaySuspend: false }),
        "33": Object.assign(_guardTrap(0, trampoline24, false), { _jcoMaySuspend: false }),
        "34": Object.assign(_guardTrap(0, trampoline25, false), { _jcoMaySuspend: false }),
        "35": Object.assign(_guardTrap(0, trampoline26, false), { _jcoMaySuspend: false }),
        "36": Object.assign(_guardTrap(0, trampoline27, false), { _jcoMaySuspend: false }),
        "37": Object.assign(_guardTrap(0, trampoline28, false), { _jcoMaySuspend: false }),
        "38": Object.assign(_guardTrap(0, trampoline29, false), { _jcoMaySuspend: false }),
        "39": Object.assign(_guardTrap(0, trampoline30, false), { _jcoMaySuspend: false }),
        "4": Object.assign(exports2.clock_time_get, { _jcoMaySuspend: false }),
        "40": Object.assign(_guardTrap(0, trampoline31, false), { _jcoMaySuspend: false }),
        "41": Object.assign(_guardTrap(0, trampoline32, false), { _jcoMaySuspend: false }),
        "42": Object.assign(_guardTrap(0, trampoline33, false), { _jcoMaySuspend: false }),
        "43": Object.assign(_guardTrap(0, trampoline34, false), { _jcoMaySuspend: false }),
        "44": Object.assign(_guardTrap(0, trampoline35, false), { _jcoMaySuspend: false }),
        "45": Object.assign(_guardTrap(0, trampoline36, false), { _jcoMaySuspend: false }),
        "46": Object.assign(_guardTrap(0, trampoline37, false), { _jcoMaySuspend: false }),
        "47": Object.assign(_guardTrap(0, trampoline38, false), { _jcoMaySuspend: false }),
        "48": Object.assign(_guardTrap(0, trampoline39, false), { _jcoMaySuspend: false }),
        "49": Object.assign(_guardTrap(0, trampoline40, false), { _jcoMaySuspend: false }),
        "5": Object.assign(exports2.fd_close, { _jcoMaySuspend: false }),
        "50": Object.assign(_guardTrap(0, trampoline41, false), { _jcoMaySuspend: false }),
        "51": Object.assign(_guardTrap(0, trampoline42, false), { _jcoMaySuspend: false }),
        "52": Object.assign(_guardTrap(0, trampoline43, false), { _jcoMaySuspend: false }),
        "53": Object.assign(_guardTrap(0, trampoline44, false), { _jcoMaySuspend: false }),
        "54": Object.assign(_guardTrap(0, trampoline45, false), { _jcoMaySuspend: false }),
        "55": Object.assign(_guardTrap(0, trampoline46, false), { _jcoMaySuspend: false }),
        "56": Object.assign(_guardTrap(0, trampoline47, false), { _jcoMaySuspend: false }),
        "57": Object.assign(_guardTrap(0, trampoline48, false), { _jcoMaySuspend: false }),
        "6": Object.assign(exports2.fd_fdstat_get, { _jcoMaySuspend: false }),
        "7": Object.assign(exports2.fd_fdstat_set_flags, { _jcoMaySuspend: false }),
        "8": Object.assign(exports2.fd_filestat_get, { _jcoMaySuspend: false }),
        "9": Object.assign(exports2.fd_prestat_get, { _jcoMaySuspend: false })
      },
      shim: {
        $imports: exports0.$imports
      }
    }));
    run0212Run = exports2["wasi:cli/run@0.2.12#run"];
    const run0212 = {
      run
    };
    return { run: run0212, "wasi:cli/run@0.2.12": run0212 };
  })();
  let promise, resolve, reject;
  function normalizeInstantiationError(e) {
    if (typeof WebAssembly2 !== "undefined" && typeof WebAssembly2.SuspendError === "function" && e instanceof WebAssembly2.SuspendError) {
      return new WebAssembly2.RuntimeError("cannot block a synchronous task before returning");
    }
    return e;
  }
  function runNext(value) {
    try {
      let done;
      do {
        ({ value, done } = gen.next(value));
      } while (!(value instanceof Promise) && !done);
      if (done) {
        if (resolve) return resolve(value);
        else return value;
      }
      if (!promise) promise = new Promise((_resolve, _reject) => (resolve = _resolve, reject = _reject));
      value.then((nextVal) => done ? resolve() : runNext(nextVal), (e) => reject(normalizeInstantiationError(e)));
    } catch (e) {
      e = normalizeInstantiationError(e);
      if (reject) reject(e);
      else throw e;
    }
  }
  const maybeSyncReturn = runNext(null);
  return promise || maybeSyncReturn;
}

// lib/api.js
var yosys = new Application(yosys_resources_exports, instantiate, "yowasp-yosys");
var runYosys = yosys.run.bind(yosys);
var commands = { "yosys": runYosys };
var version = "0.71.188-dev.1267";
export {
  Exit,
  commands,
  runYosys,
  version
};
