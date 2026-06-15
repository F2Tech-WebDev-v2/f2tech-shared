// Country-name → ISO 3166-1 alpha-2 lookup. Framework-agnostic — pass
// the returned ISO code to your renderer of choice:
//
//   React (alpha-eye pattern):
//     import * as Flags from "country-flag-icons/react/3x2";
//     const iso = iso2ForCountryName(stock.country);
//     return iso ? <Flags[iso] title={stock.country} /> : null;
//
//   Angular / plain DOM:
//     const iso = iso2ForCountryName(country);
//     <img src={`/assets/flags/${iso}.svg`} alt={country} />
//
// Why a name→ISO map (and not just shipping the SVGs):
//   - SPAs already vary on how they render flags (React component,
//     <img> src, CSS background). Centralising name normalisation is
//     the high-leverage piece; rendering stays per-app.
//   - Avoids ~2 MB of SVG bytes inside f2tech-shared.
//   - country-flag-icons is the de-facto flag SVG source for the org
//     (used by alpha-eye); consumers install it as a sibling dep.
//
// Aliases included for the patterns producers ship for US-listed
// equities: full ISO short names, "Republic of X" variants, common
// offshore-incorporated / ADR-source aliases (Cayman, BVI, Marshall
// Islands), and historic short forms (e.g. "Russia" / "Russian
// Federation"). Lookup is case-insensitive and tolerant of
// surrounding whitespace.

const ALIASES = Object.freeze({
  // North America
  "united states": "US",
  "united states of america": "US",
  "usa": "US",
  "u.s.a.": "US",
  "u.s.": "US",
  "us": "US",
  "canada": "CA",
  "mexico": "MX",
  "puerto rico": "PR",

  // United Kingdom + Crown Dependencies
  "united kingdom": "GB",
  "great britain": "GB",
  "uk": "GB",
  "u.k.": "GB",
  "england": "GB",
  "scotland": "GB",
  "wales": "GB",
  "northern ireland": "GB",
  "ireland": "IE",
  "republic of ireland": "IE",
  "isle of man": "IM",
  "jersey": "JE",
  "guernsey": "GG",
  "gibraltar": "GI",

  // Western + Northern Europe
  "france": "FR",
  "germany": "DE",
  "netherlands": "NL",
  "the netherlands": "NL",
  "holland": "NL",
  "belgium": "BE",
  "luxembourg": "LU",
  "switzerland": "CH",
  "austria": "AT",
  "denmark": "DK",
  "sweden": "SE",
  "norway": "NO",
  "finland": "FI",
  "iceland": "IS",
  "monaco": "MC",
  "liechtenstein": "LI",

  // Southern Europe
  "italy": "IT",
  "spain": "ES",
  "portugal": "PT",
  "greece": "GR",
  "malta": "MT",
  "cyprus": "CY",
  "vatican city": "VA",
  "san marino": "SM",
  "andorra": "AD",

  // Central + Eastern Europe
  "poland": "PL",
  "czech republic": "CZ",
  "czechia": "CZ",
  "slovakia": "SK",
  "hungary": "HU",
  "romania": "RO",
  "bulgaria": "BG",
  "croatia": "HR",
  "serbia": "RS",
  "slovenia": "SI",
  "bosnia and herzegovina": "BA",
  "albania": "AL",
  "north macedonia": "MK",
  "macedonia": "MK",
  "montenegro": "ME",
  "kosovo": "XK",
  "moldova": "MD",
  "ukraine": "UA",
  "belarus": "BY",
  "estonia": "EE",
  "latvia": "LV",
  "lithuania": "LT",
  "russia": "RU",
  "russian federation": "RU",

  // Caribbean + Latin America
  "bermuda": "BM",
  "cayman islands": "KY",
  "british virgin islands": "VG",
  "virgin islands, british": "VG",
  "u.s. virgin islands": "VI",
  "virgin islands, u.s.": "VI",
  "bahamas": "BS",
  "the bahamas": "BS",
  "barbados": "BB",
  "trinidad and tobago": "TT",
  "jamaica": "JM",
  "dominican republic": "DO",
  "haiti": "HT",
  "cuba": "CU",
  "curacao": "CW",
  "curaçao": "CW",
  "aruba": "AW",
  "saint kitts and nevis": "KN",
  "saint lucia": "LC",
  "saint vincent and the grenadines": "VC",
  "grenada": "GD",
  "antigua and barbuda": "AG",
  "anguilla": "AI",
  "guyana": "GY",
  "suriname": "SR",
  "venezuela": "VE",
  "colombia": "CO",
  "ecuador": "EC",
  "peru": "PE",
  "bolivia": "BO",
  "chile": "CL",
  "argentina": "AR",
  "uruguay": "UY",
  "paraguay": "PY",
  "brazil": "BR",
  "panama": "PA",
  "costa rica": "CR",
  "nicaragua": "NI",
  "honduras": "HN",
  "el salvador": "SV",
  "guatemala": "GT",
  "belize": "BZ",

  // Asia
  "china": "CN",
  "people's republic of china": "CN",
  "mainland china": "CN",
  "hong kong": "HK",
  "macau": "MO",
  "macao": "MO",
  "taiwan": "TW",
  "japan": "JP",
  "south korea": "KR",
  "korea, republic of": "KR",
  "republic of korea": "KR",
  "korea": "KR",
  "north korea": "KP",
  "korea, democratic people's republic of": "KP",
  "mongolia": "MN",
  "india": "IN",
  "pakistan": "PK",
  "bangladesh": "BD",
  "sri lanka": "LK",
  "nepal": "NP",
  "bhutan": "BT",
  "maldives": "MV",
  "afghanistan": "AF",
  "thailand": "TH",
  "vietnam": "VN",
  "viet nam": "VN",
  "cambodia": "KH",
  "laos": "LA",
  "myanmar": "MM",
  "burma": "MM",
  "malaysia": "MY",
  "singapore": "SG",
  "indonesia": "ID",
  "philippines": "PH",
  "brunei": "BN",
  "timor-leste": "TL",
  "east timor": "TL",

  // Middle East
  "israel": "IL",
  "palestine": "PS",
  "palestinian territory": "PS",
  "saudi arabia": "SA",
  "united arab emirates": "AE",
  "uae": "AE",
  "qatar": "QA",
  "kuwait": "KW",
  "bahrain": "BH",
  "oman": "OM",
  "yemen": "YE",
  "jordan": "JO",
  "lebanon": "LB",
  "syria": "SY",
  "iraq": "IQ",
  "iran": "IR",
  "turkey": "TR",
  "türkiye": "TR",

  // Caucasus + Central Asia
  "georgia": "GE",
  "armenia": "AM",
  "azerbaijan": "AZ",
  "kazakhstan": "KZ",
  "uzbekistan": "UZ",
  "kyrgyzstan": "KG",
  "tajikistan": "TJ",
  "turkmenistan": "TM",

  // Africa
  "south africa": "ZA",
  "egypt": "EG",
  "morocco": "MA",
  "tunisia": "TN",
  "algeria": "DZ",
  "libya": "LY",
  "sudan": "SD",
  "south sudan": "SS",
  "ethiopia": "ET",
  "kenya": "KE",
  "tanzania": "TZ",
  "uganda": "UG",
  "rwanda": "RW",
  "burundi": "BI",
  "somalia": "SO",
  "djibouti": "DJ",
  "eritrea": "ER",
  "nigeria": "NG",
  "ghana": "GH",
  "ivory coast": "CI",
  "côte d'ivoire": "CI",
  "cote d'ivoire": "CI",
  "senegal": "SN",
  "mali": "ML",
  "burkina faso": "BF",
  "niger": "NE",
  "guinea": "GN",
  "guinea-bissau": "GW",
  "sierra leone": "SL",
  "liberia": "LR",
  "togo": "TG",
  "benin": "BJ",
  "gambia": "GM",
  "the gambia": "GM",
  "cape verde": "CV",
  "cabo verde": "CV",
  "mauritania": "MR",
  "cameroon": "CM",
  "central african republic": "CF",
  "chad": "TD",
  "republic of the congo": "CG",
  "congo": "CG",
  "democratic republic of the congo": "CD",
  "dr congo": "CD",
  "gabon": "GA",
  "equatorial guinea": "GQ",
  "sao tome and principe": "ST",
  "são tomé and príncipe": "ST",
  "angola": "AO",
  "zambia": "ZM",
  "zimbabwe": "ZW",
  "mozambique": "MZ",
  "malawi": "MW",
  "namibia": "NA",
  "botswana": "BW",
  "lesotho": "LS",
  "eswatini": "SZ",
  "swaziland": "SZ",
  "madagascar": "MG",
  "mauritius": "MU",
  "seychelles": "SC",
  "comoros": "KM",

  // Oceania
  "australia": "AU",
  "new zealand": "NZ",
  "papua new guinea": "PG",
  "fiji": "FJ",
  "solomon islands": "SB",
  "vanuatu": "VU",
  "samoa": "WS",
  "tonga": "TO",
  "kiribati": "KI",
  "tuvalu": "TV",
  "nauru": "NR",
  "palau": "PW",
  "micronesia": "FM",
  "marshall islands": "MH",
  "cook islands": "CK",
  "new caledonia": "NC",
  "french polynesia": "PF",
});

const ISO_TO_CANONICAL = Object.freeze({
  US: "United States",      CA: "Canada",                MX: "Mexico",
  PR: "Puerto Rico",        GB: "United Kingdom",        IE: "Ireland",
  IM: "Isle of Man",        JE: "Jersey",                GG: "Guernsey",
  GI: "Gibraltar",          FR: "France",                DE: "Germany",
  NL: "Netherlands",        BE: "Belgium",               LU: "Luxembourg",
  CH: "Switzerland",        AT: "Austria",               DK: "Denmark",
  SE: "Sweden",             NO: "Norway",                FI: "Finland",
  IS: "Iceland",            MC: "Monaco",                LI: "Liechtenstein",
  IT: "Italy",              ES: "Spain",                 PT: "Portugal",
  GR: "Greece",             MT: "Malta",                 CY: "Cyprus",
  VA: "Vatican City",       SM: "San Marino",            AD: "Andorra",
  PL: "Poland",             CZ: "Czech Republic",        SK: "Slovakia",
  HU: "Hungary",            RO: "Romania",               BG: "Bulgaria",
  HR: "Croatia",            RS: "Serbia",                SI: "Slovenia",
  BA: "Bosnia and Herzegovina", AL: "Albania",           MK: "North Macedonia",
  ME: "Montenegro",         XK: "Kosovo",                MD: "Moldova",
  UA: "Ukraine",            BY: "Belarus",               EE: "Estonia",
  LV: "Latvia",              LT: "Lithuania",             RU: "Russia",
  BM: "Bermuda",            KY: "Cayman Islands",        VG: "British Virgin Islands",
  VI: "U.S. Virgin Islands", BS: "Bahamas",              BB: "Barbados",
  TT: "Trinidad and Tobago", JM: "Jamaica",              DO: "Dominican Republic",
  HT: "Haiti",              CU: "Cuba",                  CW: "Curaçao",
  AW: "Aruba",              KN: "Saint Kitts and Nevis", LC: "Saint Lucia",
  VC: "Saint Vincent and the Grenadines", GD: "Grenada", AG: "Antigua and Barbuda",
  AI: "Anguilla",           GY: "Guyana",                SR: "Suriname",
  VE: "Venezuela",          CO: "Colombia",              EC: "Ecuador",
  PE: "Peru",               BO: "Bolivia",               CL: "Chile",
  AR: "Argentina",          UY: "Uruguay",               PY: "Paraguay",
  BR: "Brazil",             PA: "Panama",                CR: "Costa Rica",
  NI: "Nicaragua",          HN: "Honduras",              SV: "El Salvador",
  GT: "Guatemala",          BZ: "Belize",                CN: "China",
  HK: "Hong Kong",          MO: "Macau",                 TW: "Taiwan",
  JP: "Japan",              KR: "South Korea",           KP: "North Korea",
  MN: "Mongolia",           IN: "India",                 PK: "Pakistan",
  BD: "Bangladesh",         LK: "Sri Lanka",             NP: "Nepal",
  BT: "Bhutan",             MV: "Maldives",              AF: "Afghanistan",
  TH: "Thailand",           VN: "Vietnam",               KH: "Cambodia",
  LA: "Laos",               MM: "Myanmar",               MY: "Malaysia",
  SG: "Singapore",          ID: "Indonesia",             PH: "Philippines",
  BN: "Brunei",             TL: "Timor-Leste",           IL: "Israel",
  PS: "Palestine",          SA: "Saudi Arabia",          AE: "United Arab Emirates",
  QA: "Qatar",              KW: "Kuwait",                BH: "Bahrain",
  OM: "Oman",               YE: "Yemen",                 JO: "Jordan",
  LB: "Lebanon",            SY: "Syria",                 IQ: "Iraq",
  IR: "Iran",               TR: "Turkey",                GE: "Georgia",
  AM: "Armenia",            AZ: "Azerbaijan",            KZ: "Kazakhstan",
  UZ: "Uzbekistan",         KG: "Kyrgyzstan",            TJ: "Tajikistan",
  TM: "Turkmenistan",       ZA: "South Africa",          EG: "Egypt",
  MA: "Morocco",            TN: "Tunisia",               DZ: "Algeria",
  LY: "Libya",              SD: "Sudan",                 SS: "South Sudan",
  ET: "Ethiopia",           KE: "Kenya",                 TZ: "Tanzania",
  UG: "Uganda",             RW: "Rwanda",                BI: "Burundi",
  SO: "Somalia",            DJ: "Djibouti",              ER: "Eritrea",
  NG: "Nigeria",            GH: "Ghana",                 CI: "Côte d'Ivoire",
  SN: "Senegal",            ML: "Mali",                  BF: "Burkina Faso",
  NE: "Niger",              GN: "Guinea",                GW: "Guinea-Bissau",
  SL: "Sierra Leone",       LR: "Liberia",               TG: "Togo",
  BJ: "Benin",              GM: "Gambia",                CV: "Cape Verde",
  MR: "Mauritania",         CM: "Cameroon",              CF: "Central African Republic",
  TD: "Chad",               CG: "Republic of the Congo", CD: "Democratic Republic of the Congo",
  GA: "Gabon",              GQ: "Equatorial Guinea",     ST: "São Tomé and Príncipe",
  AO: "Angola",             ZM: "Zambia",                ZW: "Zimbabwe",
  MZ: "Mozambique",         MW: "Malawi",                NA: "Namibia",
  BW: "Botswana",           LS: "Lesotho",               SZ: "Eswatini",
  MG: "Madagascar",         MU: "Mauritius",             SC: "Seychelles",
  KM: "Comoros",            AU: "Australia",             NZ: "New Zealand",
  PG: "Papua New Guinea",   FJ: "Fiji",                  SB: "Solomon Islands",
  VU: "Vanuatu",            WS: "Samoa",                 TO: "Tonga",
  KI: "Kiribati",           TV: "Tuvalu",                NR: "Nauru",
  PW: "Palau",              FM: "Micronesia",            MH: "Marshall Islands",
  CK: "Cook Islands",       NC: "New Caledonia",         PF: "French Polynesia",
});

function norm(name) {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/**
 * Map an English country name (any common alias) to its ISO 3166-1
 * alpha-2 code. Case-insensitive, trims whitespace. Returns undefined
 * when nothing matches — caller decides whether to fall back to plain
 * text or skip the flag entirely.
 *
 * @param {string | null | undefined} name
 * @returns {string | undefined}
 */
export function iso2ForCountryName(name) {
  const key = norm(name);
  if (!key) return undefined;
  return ALIASES[key];
}

/**
 * Canonical short English name for an ISO 3166-1 alpha-2 code. Useful
 * when the producer ships ISO codes and the UI wants a human label.
 *
 * @param {string | null | undefined} iso
 * @returns {string | undefined}
 */
export function nameForIso2(iso) {
  if (typeof iso !== "string") return undefined;
  return ISO_TO_CANONICAL[iso.trim().toUpperCase()];
}

/** Read-only alias map — exposed so consumers can extend with locale-
 *  specific synonyms via a wrapping table without forking this module. */
export const COUNTRY_NAME_ALIASES = ALIASES;
