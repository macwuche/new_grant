import { useEffect, useRef, useState } from 'react';
import { LottieLight, type LottieHandle } from 'lottie-react';
import animationData from '@assets/finding_1790360306690.json';

export default function GrantMatchingAnimation({ onPlay }: { onPlay: () => void }) {
  const player = useRef<LottieHandle>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) player.current?.play();
  }, [ready]);

  return (
    <LottieLight
      src={animationData}
      className="auth-match-lottie"
      autoplay
      loop
      lottieRef={player}
      subscriptions={{
        ready: () => setReady(true),
        play: onPlay,
      }}
      aria-hidden="true"
    />
  );
}