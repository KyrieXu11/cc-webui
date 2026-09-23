// 最小 ZIP 打包器：store（不压缩）+ data descriptor，全程流式。
//
// 为什么自己写而不是加依赖：要做的只有「把几个已经在盘上的文件塞进一个壳」这一件
// 事，而 archiver 那一类库还带着 vfs / glob / 压缩策略一整层。
//
// **不压缩是有意的**：取件台里的东西多半是 xlsx / docx / png（自身已经压过），
// 纯文本吃点亏，换来的是这段代码不用管压缩流的背压和二次计数。
//
// data descriptor（flag bit 3）是关键：crc32 和长度要把文件读完才知道，而 local
// header 排在数据前面。用 descriptor 就能边读边发——一个 500MB 的产出不会先被读
// 进内存，也不必为了算 crc 把文件读两遍。附带的好处是**下载途中文件被 agent 改写
// 也不会写出坏包**：长度是实际发出去多少就写多少。
//
// ⚠️ 没有 ZIP64：单个文件 ≥ 4GiB 会写出坏包，所以调用方必须先按 stat 挡掉
// （files-routes.ts 那条 413），这里再兜一次底（读的过程中长出来的情况）。

import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import zlib from "node:zlib";

export type ZipEntry = {
  /** 盘上的绝对路径。 */
  path: string;
  /** 包里的名字，`/` 分隔、UTF-8。 */
  name: string;
  /** 修改时间，写进 DOS 时间戳。缺省＝现在。 */
  mtimeMs?: number;
};

/** 单个条目的上限（uint32）。超过就得上 ZIP64，而这里没有。 */
export const ZIP_MAX_ENTRY_BYTES = 0xffffffff;

const LOCAL_SIG = 0x04034b50;
const DESC_SIG = 0x08074b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// bit 3 = crc 与长度放在数据后面的 data descriptor 里；bit 11 = 文件名是 UTF-8
// （不置这一位，中文名在 Windows 的资源管理器里就是乱码）。
const FLAGS = 0x0008 | 0x0800;
const STORE = 0;
const VERSION = 20; // 2.0 —— data descriptor 要求的最低版本

export function zipStream(entries: ZipEntry[]): ReadableStream<Uint8Array> {
  return Readable.toWeb(
    Readable.from(zipChunks(entries), { objectMode: false }),
  ) as unknown as ReadableStream<Uint8Array>;
}

async function* zipChunks(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, "utf-8");
    const { time, date } = dosStamp(e.mtimeMs ?? Date.now());

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION, 4);
    local.writeUInt16LE(FLAGS, 6);
    local.writeUInt16LE(STORE, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    // 14/18/22 = crc / 压缩后长度 / 原始长度，这里全留 0：真值在数据后面。
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    yield local;

    let crc = 0;
    let size = 0;
    for await (const chunk of createReadStream(e.path)) {
      const buf = chunk as Buffer;
      crc = zlib.crc32(buf, crc);
      size += buf.length;
      if (size > ZIP_MAX_ENTRY_BYTES) {
        throw new Error(`${e.name} 超过 4GiB，这个打包器没有 ZIP64`);
      }
      yield buf;
    }

    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(DESC_SIG, 0);
    desc.writeUInt32LE(crc, 4);
    desc.writeUInt32LE(size, 8); // store：压缩后长度＝原始长度
    desc.writeUInt32LE(size, 12);
    yield desc;

    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(CENTRAL_SIG, 0);
    cd.writeUInt16LE((3 << 8) | VERSION, 4); // made by: unix
    cd.writeUInt16LE(VERSION, 6);
    cd.writeUInt16LE(FLAGS, 8);
    cd.writeUInt16LE(STORE, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(name.length, 28);
    // 30 extra / 32 comment / 34 disk / 36 internal 一律 0
    cd.writeUInt32LE(((0o100644 << 16) >>> 0), 38); // 外部属性：unix 普通文件 0644
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);

    offset += local.length + size + desc.length;
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const b of central) {
    cdSize += b.length;
    yield b;
  }

  const end = Buffer.alloc(22);
  end.writeUInt32LE(EOCD_SIG, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(cdOffset, 16);
  end.writeUInt16LE(0, 20);
  yield end;
}

// DOS 时间戳：秒只有 1 位精度（除以 2），年份从 1980 起算。1980 以前的时间没法
// 表示，落到 1980-01-01。
function dosStamp(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1980) {
    return { time: 0, date: (1 << 5) | 1 };
  }
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
