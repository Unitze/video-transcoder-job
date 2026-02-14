import type { FFprobeOutput } from "./types/ffprobe";

import { spawn } from "child_process";
import fs from "fs";
import { PassThrough, Readable, Writable } from "stream";

const noop = () => {};

async function main() {
  const startTime = Date.now();
  console.log("Starting video transcoding job...");
  console.log("Original video URL:", process.env.ORIGINAL_URL);

  // ffprobeで情報を取る
  console.log("Probing video information with ffprobe...");
  const rawFFprobeResult = await spawnFFprobe([
    "-i",
    process.env.ORIGINAL_URL,
    "-hide_banner",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
  ], "string") as string;

  // ffprobeの結果を出力する
  console.log("Uploading ffprobe result...");
  await Readable.from(rawFFprobeResult).pipe(createOutStream(process.env.PROBE_DEST_URL, {
    contentType: "application/json; charset=UTF-8",
    contentLength: Buffer.byteLength(rawFFprobeResult),
  })).waitForFinish();

  console.log("Analyzing ffprobe result...");
  const probeResult = JSON.parse(rawFFprobeResult) as FFprobeOutput;
  const videoStream = probeResult.streams.find((s) => s.codec_type === "video");
  const audioStream = probeResult.streams.find((s) => s.codec_type === "audio");
  const hasH264Video = process.env.FILENAME.endsWith(".mp4") && videoStream?.codec_name === "h264";
  const is720pOrLower = (videoStream?.height ?? 0) <= 720;
  const is1080pOrLower = (videoStream?.height ?? 0) <= 1080;
  const hasAACAudio = audioStream?.codec_name === "aac";
  const durationSec = parseFloat(probeResult.format.duration);
  const is50MBOrLower = parseFloat(probeResult.format.size) <= 50 * 1024 * 1024;
  const audioOptions = hasAACAudio ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"];

  if (process.env.OGP_DEST_URL) {
    // OGP用動画を作る
    if (hasH264Video && is720pOrLower && durationSec <= 8 * 60 && is50MBOrLower) {
      console.log("The original video is already H.264 and 720p or lower and duration is 8 minutes or less and size is 50MB or less, skipping OGP video generation.");
    } else {
      console.log("Generating OGP video...");
      using file = await spawnFFmpeg([
        "-hide_banner",
        "-t", "480",
        "-i", process.env.ORIGINAL_URL,
        "-vf", "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-movflags", "+faststart",
        ...audioOptions,
        "-f", "mp4",
      ], "file");

      const outStream = createOutStream(process.env.OGP_DEST_URL, {
        contentType: "video/mp4; codecs=avc1.42E01E, mp4a.40.2",
        contentLength: await file.getSize(),
      });

      await file.getReader().pipe(outStream).waitForFinish();

      global.gc?.();
    }
  }

  if (process.env.MAIN_DEST_URL) {
    // 視聴ページ用動画を作る
    if (hasH264Video && is1080pOrLower) {
      console.log("The original video is already H.264 and 1080p or lower, skipping main video generation.");
    } else {
      console.log("Generating main video...");
      using file = await spawnFFmpeg([
        "-hide_banner",
        "-i", process.env.ORIGINAL_URL,
        "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-movflags", "+faststart",
        ...audioOptions,
        "-f", "mp4",
      ], "file");

      const outStream = createOutStream(process.env.MAIN_DEST_URL, {
        contentType: "video/mp4; codecs=avc1.64002A, mp4a.40.2",
        contentLength: await file.getSize(),
      });

      await file.getReader().pipe(outStream).waitForFinish();
    }
  }

  console.log("All uploads completed, reporting completion...");
  await fetch(process.env.REPORT_URL, { method: "GET" }).then(res => res.arrayBuffer()).catch(noop);

  const endTime = Date.now();
  const jobDurationSec = (endTime - startTime) / 1000;
  console.log(`All done! Total job duration: ${jobDurationSec.toFixed(2)} seconds (${(jobDurationSec / durationSec * 100).toFixed(2)}% speed).`);
}

interface FSFileArtifact {
  type: "fs-file";
  filename: string;
  getReader: () => Readable;
  getSize: () => Promise<number>;
  [Symbol.dispose]: () => void;
}

interface BaseSpawnFFmpegTypeMap {
  string: string;
  file: FSFileArtifact;
}

async function baseSpawnFFmpeg<T extends keyof BaseSpawnFFmpegTypeMap>(binary: string, args: string[], out: T): Promise<BaseSpawnFFmpegTypeMap[T]> {
  return new Promise((resolve, reject) => {
    const filename = `/tmp/${crypto.randomUUID().replaceAll("-", "")}.tmp`;

    if (out === "file") {
      args.push(filename);
    }

    const ffmpeg = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    ffmpeg.stderr.pipe(process.stderr);

    if (out === "file") {
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve({
            type: "fs-file",
            filename,
            getReader: () => fs.createReadStream(filename),
            getSize: async () => (await fs.promises.stat(filename)).size,
            [Symbol.dispose]: () => fs.unlinkSync(filename),
          } as unknown as BaseSpawnFFmpegTypeMap[T]);
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    } else if (out === "string") {
      const bufs: Buffer[] = [];
      ffmpeg.stdout.on("data", (chunk) => {
        bufs.push(chunk);
      });
      ffmpeg.stdout.on("end", () => {
        const output = Buffer.concat(bufs).toString();
        resolve(output as unknown as BaseSpawnFFmpegTypeMap[T]);
      });
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    } else {
      reject(new Error(`Invalid output type: ${out}`));
    }
  });
}

const spawnFFmpeg = <T extends keyof BaseSpawnFFmpegTypeMap>(args: string[], out: T): Promise<BaseSpawnFFmpegTypeMap[T]> => baseSpawnFFmpeg("ffmpeg", args, out);
const spawnFFprobe = <T extends keyof BaseSpawnFFmpegTypeMap>(args: string[], out: T): Promise<BaseSpawnFFmpegTypeMap[T]> => baseSpawnFFmpeg("ffprobe", args, out);

function createOutStream(dest: string, options: { contentType: string, contentLength: number }): Writable & { waitForFinish: () => Promise<void> } {
  if (dest.startsWith("http://") || dest.startsWith("https://")) {
    // HTTP PUTで送るストリームを作る
    const pass = new PassThrough();

    const fetchPromise = fetch(dest, {
      method: "PUT",
      body: pass,
      headers: {
        "content-length": options.contentLength.toString(),
        "content-type": options.contentType,
      },
      // @ts-ignore: Nodeのfetchでストリームを送る場合に必要なおまじない
      duplex: "half",
    }).then((res) => {
      if (!res.ok) {
        console.error(`Failed to upload to ${dest}: ${res.status} ${res.statusText}`);
        process.exit(1);
      }

      res.arrayBuffer().catch(noop); // 応答を消費してメモリリークを防ぐ
    }).catch((err) => {
      console.error(`Error uploading to ${dest}:`, err);
      process.exit(1);
    });

    return Object.assign(pass, { waitForFinish: () => fetchPromise });
  } else {
    const stream = fs.createWriteStream(dest);

    return Object.assign(stream, { waitForFinish: async () => waitForStreamFinish(stream) });
  }
}

function waitForStreamFinish(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

main();
