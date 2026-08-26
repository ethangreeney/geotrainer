import { NotFound, usePath } from './router'
import Landing from './views/Landing'
import Start from './views/Start'
import Dashboard from './views/Dashboard'

/* The whole site, and the Worker's SPA fallback has to agree with it: anything
   not named here is answered with a 404 status as well as this 404 page (see
   KNOWN_PAGES in cloud/src/worker.mjs). */
const PAGES: Record<string, () => React.ReactElement> = {
  '/': Landing,
  '/start': Start,
  '/app': Dashboard,
}

export default function App() {
  const path = usePath()
  const View = PAGES[path]
  return (
    <>
      <div className="bloom" aria-hidden />
      {View ? <View /> : <NotFound path={path} />}
    </>
  )
}
