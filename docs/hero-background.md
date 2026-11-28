# Homepage hero background

The photograph behind the homepage hero is an original image made for iSpry. It is not a stock photo, it has no watermark, and it is not under a third-party license. iSpry may use it commercially on ispry.ai.

The scene is a quiet living room at dusk: a face-down phone, a lamp, and hills through the window. There are no people, no physician likeness, and no text or logos in the file.

Self-hosted derivatives live in `public/media/`. Byte sizes:

| Width | AVIF | WebP | JPEG |
| --- | ---: | ---: | ---: |
| 768 | 8.2 KB | 9.7 KB | 19.0 KB |
| 1280 | 17.2 KB | 21.0 KB | 41.5 KB |
| 1920 | 28.3 KB | 34.7 KB | 72.1 KB |

The homepage `srcset` asks the browser for one width (`sizes="100vw"`). A phone loads the 768-wide AVIF, about 8 KB, under the 250 KB mobile budget. `vercel.json` already allows images from `'self'` and caches `/media/` for a year. The hero headline stays the LCP element, so the photograph is not preloaded.
