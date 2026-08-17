import { usePath } from './router'
import Landing from './views/Landing'
import Start from './views/Start'
import Dashboard from './views/Dashboard'

export default function App() {
  const path = usePath()
  return (
    <>
      <div className="grat" aria-hidden />
      {path === '/start' ? <Start /> : path === '/app' ? <Dashboard /> : <Landing />}
    </>
  )
}
