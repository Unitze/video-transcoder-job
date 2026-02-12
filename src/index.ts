import type { FFprobeOutput } from "./types/ffprobe";

import { spawn } from "child_process";
import fs from "fs";
import { PassThrough, Readable, Writable } from "stream";

const noop = () => {};

async function main() {

  // ffprobeで情報を取る
  const rawFFprobeResult = await spawnFFprobe([
    "-i",
    process.env.ORIGINAL_URL,
    "-hide_banner",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
  ]) as string;

  // ffprobeの結果を出力する
  await waitForStreamFinish(
    Readable.from(rawFFprobeResult).pipe(createOutStream(process.env.PROBE_DEST_URL))
  );

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
      const passThrough = new PassThrough();

      const ffmpegArgs = [
        "-i", process.env.ORIGINAL_URL,
        "-vf", "scale='min(1280,iw)':'min(720,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "28",
        "-movflags", "frag_keyframe+empty_moov",
        ...audioOptions,
        "-f", "mp4",
        "pipe:1",
      ];

      await Promise.all([
        spawnFFmpeg(ffmpegArgs, passThrough),
        waitForStreamFinish(passThrough.pipe(createOutStream(process.env.OGP_DEST_URL))),
      ]);
    }
  }

  if (process.env.MAIN_DEST_URL) {
    // 視聴ページ用動画を作る
    if (hasH264Video && is1080pOrLower) {
      console.log("The original video is already H.264 and 1080p or lower, skipping main video generation.");
    } else {
      const passThrough = new PassThrough();

      const ffmpegArgs = [
        "-i", process.env.ORIGINAL_URL,
        "-vf", "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-movflags", "frag_keyframe+empty_moov",
        ...audioOptions,
        "-f", "mp4",
        "pipe:1",
      ];

      await Promise.all([
        spawnFFmpeg(ffmpegArgs, passThrough),
        waitForStreamFinish(passThrough.pipe(createOutStream(process.env.MAIN_DEST_URL))),
      ]);
    }
  }

  await ensureAllFetchesDone();
  await fetch(process.env.REPORT_URL, { method: "GET" }).then(res => res.arrayBuffer()).catch(noop);

  console.log("Done!");
}

async function baseSpawnFFmpeg(binary: string, args: string[], outStream?: Writable): Promise<void | string> {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });

    ffmpeg.stderr.pipe(process.stderr);

    if (outStream) {
      ffmpeg.stdout.pipe(outStream);
      ffmpeg.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    } else {
      const bufs: Buffer[] = [];
      ffmpeg.stdout.on("data", (chunk) => {
        bufs.push(chunk);
      });
      ffmpeg.stdout.on("end", () => {
        const output = Buffer.concat(bufs).toString();
        resolve(output);
      });
      ffmpeg.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`FFmpeg exited with code ${code}`));
        }
      });
    }
  });
}

const spawnFFmpeg = baseSpawnFFmpeg.bind(null, "ffmpeg");
const spawnFFprobe = baseSpawnFFmpeg.bind(null, "ffprobe");

function createOutStream(dest: string): Writable {
  if (dest.startsWith("http://") || dest.startsWith("https://")) {
    // HTTP PUTで送るストリームを作る
    const pass = new PassThrough();

    fetchForExecution(dest, {
      method: "PUT",
      body: pass,
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

    return pass;
  } else {
    return fs.createWriteStream(dest);
  }
}

function waitForStreamFinish(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.on("finish", resolve);
    stream.on("error", reject);
  });
}

const fetchPromises: Promise<unknown>[] = [];
function fetchForExecution(url: string, init: RequestInit): Promise<Response> {
  const promise = fetch(url, init);
  fetchPromises.push(promise);
  return promise;
}

function ensureAllFetchesDone(): Promise<void> {
  return Promise.allSettled(fetchPromises).then(() => {});
}

main();
