import { useReducedMotion } from 'framer-motion';
import { LottieLight } from 'lottie-react';
import animationData from '@assets/finding_1790360306690.json';

export default function GrantMatchingAnimation() {
  const reduceMotion = useReducedMotion();

  return <LottieLight
    key={reduceMotion ? 'still' : 'animated'}
    src={animationData}
    className="auth-match-lottie"
    autoplay={!reduceMotion}
    loop={!reduceMotion}
    aria-hidden="true"
  />;
}