import { useRef, useState } from 'react';
import { useReducedMotion } from 'framer-motion';
import { LottieLight, type LottieHandle } from 'lottie-react';
import { Pause, Play } from 'lucide-react';
import animationData from '@assets/finding_1790360306690.json';

export default function GrantMatchingAnimation() {
  const reduceMotion = useReducedMotion();
  const player = useRef<LottieHandle>(null);
  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(false);

  return <>
    <LottieLight
      key={reduceMotion ? 'still' : 'animated'}
      src={animationData}
      className="auth-match-lottie"
      autoplay={!reduceMotion}
      loop
      lottieRef={player}
      subscriptions={{
        ready: () => setReady(true),
        play: () => setPlaying(true),
        pause: () => setPlaying(false),
        stop: () => setPlaying(false),
      }}
      aria-hidden="true"
    />
    <div className="auth-match-controls">
      <button
        type="button"
        className="auth-match-toggle"
        disabled={!ready}
        onClick={() => playing ? player.current?.pause() : player.current?.play()}
        data-testid="button-signup-toggle-animation"
      >
        {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {playing ? 'Pause animation' : 'Play animation'}
      </button>
      {reduceMotion && !playing && <span>Motion is reduced on this device.</span>}
    </div>
  </>;
}