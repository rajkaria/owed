// The slot for the screen recording of a real golden-path run on mainnet. Until a recording is
// added the section is not rendered at all (no empty player, no 404 for a missing file).
//
// To add one: put the files in web/public/media/ and fill in GOLDEN_PATH_VIDEO, e.g.
//   ffmpeg -i run.mov -an -vf "scale=1280:-2" -c:v libx264 -crf 26 -preset slow -movflags +faststart web/public/media/golden-path.mp4
//   ffmpeg -i web/public/media/golden-path.mp4 -frames:v 1 -q:v 3 web/public/media/golden-path.jpg
// (-an drops the audio track: the video plays muted anyway.) Width and height are the encoded size.

export interface Recording {
  src: string;
  poster: string;
  width: number;
  height: number;
  /** What the recording shows, in one sentence, e.g. "Priya pays 15 USDC from her wallet; the agent sees it land." */
  caption: string;
  /** YYYY-MM-DD it was recorded. */
  recorded: string;
}

export const GOLDEN_PATH_VIDEO: Recording | null = null;

export function GoldenPathVideo({ video = GOLDEN_PATH_VIDEO }: { video?: Recording | null }) {
  if (!video) return null;
  return (
    <section aria-labelledby="run-title" className="border-t border-line py-16 md:py-20">
      <h2 id="run-title" className="text-3xl font-semibold tracking-tight">
        A real payment, start to finish
      </h2>
      <figure className="mt-8">
        <div className="overflow-hidden rounded-2xl border border-line bg-sunken">
          <video
            className="block h-auto w-full"
            src={video.src}
            poster={video.poster}
            width={video.width}
            height={video.height}
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="metadata"
          />
        </div>
        <figcaption className="mt-3 text-sm text-muted">
          Screen recording on Solana mainnet, {video.recorded}. {video.caption}
        </figcaption>
      </figure>
    </section>
  );
}
