import { Suspense, lazy } from 'react'
import type { CountryTint } from './Globe'

/**
 * three.js plus the country geometry is most of the page weight, and neither is
 * needed to read the first screen. Split it out so type paints first.
 */
const Globe = lazy(() => import('./Globe'))

export default function GlobeLazy(props: { tint?: CountryTint }) {
  return (
    <Suspense fallback={<div className="globe" aria-hidden />}>
      <Globe {...props} />
    </Suspense>
  )
}
