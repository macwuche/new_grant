---
name: Lottie reduced motion
description: Why a visible Lottie illustration may not animate in preview and how to verify playback.
---

The Lottie React player suppresses autoplay when the browser requests reduced motion, even if the animation data loads and its SVG renders. A visible illustration is not evidence of playback. For the sign-up demo, the user explicitly asked for automatic playback with no controls even on the reduced-motion device shown in their screenshot; that later request supersedes the earlier opt-in-control approach for this brief four-second screen.

**Why:** The matching preview initially appeared as a still image on a reduced-motion device despite rendering successfully; the browser console showed the preference. Loading the animation only on the final step also produced a noticeable delay. The user subsequently rejected the playback control and required the animation to start automatically before redirecting to the demo dashboard.

**How to apply:** For this sign-up demo, ensure frames advance automatically even when reduced motion is enabled and keep the illustration on screen for four seconds before redirecting. For other Lottie experiences, do not assume this exception applies; respect reduced motion unless the user gives similarly explicit direction. Preload separate animation chunks before they are displayed.