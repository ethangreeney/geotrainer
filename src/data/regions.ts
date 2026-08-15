// Generated. Continents used by the two-stage map answer input.
export interface Region {
  id: string
  name: string
  tint: string
  members: string[]
  /**
   * Countries whose combined bounding box frames the continent when it opens.
   * A plain bounding box of every member is useless — one outlier (Russia in
   * Europe, Greenland in North America, the scattered Pacific in Oceania)
   * stretches the view until the countries you actually need are a few pixels
   * wide. Everything outside the frame is still drawn and still clickable.
   */
  frame: string[]
}

export const REGIONS: Region[] = [
  { id: "europe", name: "Europe", tint: "#1f2937", frame: ["PT","IS","NO","FI","GR","CY","UA","MT","IE"], members: ["AD","AL","AT","AX","BA","BE","BG","BY","CH","CY","CZ","DE","DK","EE","ES","FI","FO","FR","GB","GG","GI","GR","HR","HU","IE","IM","IS","IT","JE","XK","LI","LT","LU","LV","MC","MD","ME","MK","MT","NL","NO","PL","PT","RO","RS","RU","SE","SI","SJ","SK","SM","UA","VA"] },
  { id: "africa", name: "Africa", tint: "#33271f", frame: ["MA","EG","ZA","SN","SO","MG","CV"], members: ["AO","BF","BI","BJ","BW","CD","CF","CG","CI","CM","CV","DJ","DZ","EG","EH","ER","ET","GA","GH","GM","GN","GQ","GW","IO","KE","KM","LR","LS","LY","MA","MG","ML","MR","MU","MW","MZ","NA","NE","NG","RE","RW","SC","SD","SH","SL","SN","SO","SS","ST","SZ","TD","TG","TN","TZ","UG","YT","ZA","ZM","ZW"] },
  { id: "asia", name: "Asia", tint: "#2a2334", frame: ["TR","JP","ID","IN","KZ","PH","LK","MN"], members: ["AE","AF","AM","AZ","BD","BH","BN","BT","CN","GE","HK","ID","IL","IN","IQ","IR","JO","JP","KG","KH","KP","KR","KW","KZ","LA","LB","LK","MM","MN","MO","MV","MY","NP","OM","PH","PK","PS","QA","SA","SG","SY","TH","TJ","TL","TM","TR","TW","UZ","VN","YE"] },
  { id: "north-america", name: "North America", tint: "#1d2a34", frame: ["CA","US","MX","PA","CU","JM","BS"], members: ["AG","AI","AW","BB","BL","BM","BQ","BS","BZ","CA","CR","CU","CW","DM","DO","GD","GL","GP","GT","HN","HT","JM","KN","KY","LC","MF","MQ","MS","MX","NI","PA","PM","PR","SV","SX","TC","TT","US","VC","VG","VI"] },
  { id: "south-america", name: "South America", tint: "#1e2b26", frame: ["CO","BR","AR","CL","PE","VE","UY"], members: ["AR","BO","BR","CL","CO","EC","FK","GF","GY","PE","PY","SR","UY","VE"] },
  { id: "oceania", name: "Oceania", tint: "#31281a", frame: ["AU","NZ","PG","NC","FJ","SB","VU"], members: ["AS","AU","CC","CK","CX","FJ","FM","GU","KI","MH","MP","NC","NF","NR","NU","NZ","PF","PG","PN","PW","SB","TK","TO","TV","VU","WF","WS"] },
]

const BY_COUNTRY = new Map<string, Region>()
for (const r of REGIONS) for (const m of r.members) BY_COUNTRY.set(m, r)

export function regionOf(code: string): Region | undefined {
  return BY_COUNTRY.get(code)
}
