import { countryName } from '../data/countries'

/** Real flag artwork (SVG, 4:3) served from `public/flags`. */
export default function Flag({ code }: { code: string }) {
  return (
    <img
      className="flag"
      src={`/flags/${code.toLowerCase()}.svg`}
      alt=""
      title={countryName(code)}
      width={24}
      height={18}
      loading="lazy"
    />
  )
}
