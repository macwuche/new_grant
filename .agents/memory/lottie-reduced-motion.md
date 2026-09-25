---
name: Lottie reduced motion
description: Why a visible Lottie illustration may not animate in preview and how to verify playback.
---

The Lottie React player suppresses autoplay when the browser requests reduced motion, even if the animation data loads and its SVG renders. A visible illustration is not evidence of playback. Respect that preference and offer an explicit Play/Pause control so the person can opt in.

**Why:** The matching preview initially appeared as a still image on a reduced-motion device despite rendering successfully; the browser console showed the preference. Loading the animation only on the final step also produced a noticeable delay.

**How to apply:** For Lottie previews, check whether frames advance in a browser with reduced motion enabled, verify that manual Play works, and begin loading the animation before the step where it is displayed if it is fetched as a separate chunk.