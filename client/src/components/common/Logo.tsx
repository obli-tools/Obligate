import { useEffect, useState } from 'react';

/**
 * Logo variant that follows the current theme. The dark-on-light variant is
 * used only for `obli-daylight` (or any future light theme whose id ends with
 * `-daylight`); every other theme keeps the default (light-on-dark) logo,
 * including `obli-dim`, which is a DARK theme (whitelist of light themes, so
 * a new dark theme needs no change here).
 *
 * Reads the current theme from `document.documentElement.dataset.theme` and
 * subscribes to changes via MutationObserver so the swap happens live when
 * the user picks a new theme, without any prop wiring.
 */
export function Logo(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const [isLight, setIsLight] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'obli-daylight'
  );

  useEffect(() => {
    const el = document.documentElement;
    const update = () => setIsLight(el.dataset.theme === 'obli-daylight');
    update();
    const obs = new MutationObserver(update);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return <img src={isLight ? '/logo-dark.svg' : '/logo.svg'} alt="Obligate" {...props} />;
}
