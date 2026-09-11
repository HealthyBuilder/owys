/**
 * The brand table — the actual moat of this product.
 *
 * A card authorization gives you a filthy string ("SQ *BLUE BOTTLE COFFEE",
 * "NIKE.COM 8006536453", "TST* CHIPOTLE 2841") plus an MCC. Turning that into
 * "the listed parent company whose stock we should buy" is the whole game.
 *
 * Note the entries where brand != listed parent — those are the ones a naive
 * string match gets wrong, and they are a large share of real card spend.
 */

export interface Brand {
  brand: string;
  company: string;
  /** Ticker of the *listed* entity. May be an ADR. */
  ticker: string;
  /** Matched against the normalized descriptor. */
  patterns: string[];
  /** MCCs that corroborate this brand; a match here raises confidence. */
  mcc?: number[];
  /** Why brand != company, surfaced in the resolver trace and the UI. */
  note?: string;
  /** True when the listed entity is only indirect exposure, not the brand itself. */
  proxy?: boolean;
}

export const BRANDS: Brand[] = [
  // ---- big tech / subscriptions -------------------------------------------
  { brand: "Apple", company: "Apple Inc.", ticker: "AAPL", mcc: [5732, 5815, 5817, 5818],
    patterns: ["APPLE", "APPLE STORE", "APPLE COM BILL", "ITUNES", "APPLE MUSIC", "APPLE TV"] },
  { brand: "Amazon", company: "Amazon.com Inc.", ticker: "AMZN", mcc: [5942, 5999, 5411],
    patterns: ["AMAZON", "AMZN", "AMAZON MKTPL", "AMZN MKTP", "PRIME VIDEO", "AUDIBLE", "AWS", "AMAZON WEB SERVICES"] },
  { brand: "Whole Foods", company: "Amazon.com Inc.", ticker: "AMZN", mcc: [5411],
    patterns: ["WHOLE FOODS", "WHOLEFDS", "WFM"],
    note: "Whole Foods has been an Amazon subsidiary since 2017 — a name match on the brand alone finds no listing." },
  { brand: "Google", company: "Alphabet Inc.", ticker: "GOOGL", mcc: [5817, 5818, 7372],
    patterns: ["GOOGLE", "GOOGLE CLOUD", "GOOGLE STORAGE", "YOUTUBE", "YOUTUBE PREMIUM", "GOOGLE ONE"] },
  { brand: "Meta", company: "Meta Platforms Inc.", ticker: "META", mcc: [7311, 5817],
    patterns: ["META", "FACEBOOK", "FACEBK", "INSTAGRAM", "META ADS", "WHATSAPP"] },
  { brand: "Microsoft", company: "Microsoft Corp.", ticker: "MSFT", mcc: [5734, 7372, 5817],
    patterns: ["MICROSOFT", "MSFT", "XBOX", "GITHUB", "LINKEDIN", "AZURE", "OFFICE 365", "MICROSOFT 365"] },
  { brand: "Netflix", company: "Netflix Inc.", ticker: "NFLX", mcc: [5818, 4899],
    patterns: ["NETFLIX"] },
  { brand: "Spotify", company: "Spotify Technology S.A.", ticker: "SPOT", mcc: [5818],
    patterns: ["SPOTIFY"] },
  { brand: "Disney+", company: "The Walt Disney Company", ticker: "DIS", mcc: [5818, 7996],
    patterns: ["DISNEY", "DISNEY PLUS", "DISNEYPLUS", "HULU", "ESPN"] },
  { brand: "Adobe", company: "Adobe Inc.", ticker: "ADBE", mcc: [5734, 7372],
    patterns: ["ADOBE", "ADOBE CREATIVE"] },
  { brand: "ChatGPT", company: "Microsoft Corp.", ticker: "MSFT", mcc: [7372, 5817], proxy: true,
    patterns: ["OPENAI", "CHATGPT"],
    note: "OpenAI is not listed. Microsoft is its largest investor, so this is proxy exposure — a product decision the user should be told about, not hidden." },
  { brand: "Anthropic", company: "Alphabet Inc.", ticker: "GOOGL", mcc: [7372], proxy: true,
    patterns: ["ANTHROPIC", "CLAUDE AI", "CLAUDE.AI"],
    note: "Anthropic is not listed; Alphabet is a major investor. Proxy exposure only." },

  // ---- food & beverage ----------------------------------------------------
  { brand: "Starbucks", company: "Starbucks Corp.", ticker: "SBUX", mcc: [5814, 5812],
    patterns: ["STARBUCKS", "SBUX"] },
  { brand: "McDonald's", company: "McDonald's Corp.", ticker: "MCD", mcc: [5814],
    patterns: ["MCDONALD", "MCDONALDS", "MCD"] },
  { brand: "Chipotle", company: "Chipotle Mexican Grill", ticker: "CMG", mcc: [5814, 5812],
    patterns: ["CHIPOTLE"] },
  { brand: "KFC", company: "Yum! Brands Inc.", ticker: "YUM", mcc: [5814],
    patterns: ["KFC", "TACO BELL", "PIZZA HUT", "HABIT BURGER"],
    note: "KFC, Taco Bell and Pizza Hut are all Yum! Brands — three descriptors, one ticker." },
  { brand: "Burger King", company: "Restaurant Brands International", ticker: "QSR", mcc: [5814],
    patterns: ["BURGER KING", "TIM HORTON", "POPEYES", "FIREHOUSE SUBS"],
    note: "Burger King / Tim Hortons / Popeyes roll up to RBI." },
  { brand: "Domino's", company: "Domino's Pizza Inc.", ticker: "DPZ", mcc: [5814, 5812],
    patterns: ["DOMINO", "DOMINOS"] },
  { brand: "Coca-Cola", company: "The Coca-Cola Company", ticker: "KO", mcc: [5499],
    patterns: ["COCA COLA", "COCA-COLA"] },
  { brand: "Blue Bottle Coffee", company: "Nestlé S.A. (ADR)", ticker: "NSRGY", mcc: [5814, 5812],
    patterns: ["BLUE BOTTLE", "BLUEBOTTLE"],
    note: "Majority-owned by Nestlé, which trades in the US only as an ADR — an issuer may not have tokenized it." },
  { brand: "Dunkin'", company: "Inspire Brands (private)", ticker: "", mcc: [5814],
    patterns: ["DUNKIN", "DUNKIN DONUTS"],
    note: "Taken private by Inspire Brands in 2020 — there is no stock to give. An honest no-match." },
  { brand: "Trader Joe's", company: "Aldi Nord (private)", ticker: "", mcc: [5411],
    patterns: ["TRADER JOE", "TRADER JOES"],
    note: "Privately held. No ticker exists — the fallback ladder has to handle this." },

  // ---- retail -------------------------------------------------------------
  { brand: "Nike", company: "NIKE Inc.", ticker: "NKE", mcc: [5661, 5941, 5651],
    patterns: ["NIKE", "NIKE COM", "NIKETOWN"] },
  { brand: "Lululemon", company: "Lululemon Athletica", ticker: "LULU", mcc: [5651],
    patterns: ["LULULEMON", "LULU"] },
  { brand: "Costco", company: "Costco Wholesale Corp.", ticker: "COST", mcc: [5300, 5411, 5541],
    patterns: ["COSTCO", "COSTCO WHSE", "COSTCO GAS"] },
  { brand: "Walmart", company: "Walmart Inc.", ticker: "WMT", mcc: [5310, 5411],
    patterns: ["WALMART", "WAL-MART", "WM SUPERCENTER", "SAMS CLUB", "SAM'S CLUB"],
    note: "Sam's Club is a Walmart division." },
  { brand: "Target", company: "Target Corp.", ticker: "TGT", mcc: [5310, 5411],
    patterns: ["TARGET", "TARGET COM"] },
  { brand: "Home Depot", company: "The Home Depot Inc.", ticker: "HD", mcc: [5200, 5211],
    patterns: ["HOME DEPOT", "THE HOME DEPOT", "HOMEDEPOT"] },
  { brand: "Lowe's", company: "Lowe's Companies Inc.", ticker: "LOW", mcc: [5200, 5211],
    patterns: ["LOWES", "LOWE S"] },
  { brand: "Best Buy", company: "Best Buy Co. Inc.", ticker: "BBY", mcc: [5732],
    patterns: ["BEST BUY", "BESTBUY"] },
  { brand: "TJ Maxx", company: "TJX Companies Inc.", ticker: "TJX", mcc: [5651, 5311],
    patterns: ["TJ MAXX", "TJMAXX", "MARSHALLS", "HOMEGOODS", "HOME GOODS"],
    note: "TJ Maxx / Marshalls / HomeGoods are one listed company." },
  { brand: "Old Navy", company: "The Gap Inc.", ticker: "GAP", mcc: [5651],
    patterns: ["OLD NAVY", "BANANA REPUBLIC", "ATHLETA", "GAP"],
    note: "Old Navy, Banana Republic and Athleta are all Gap Inc. brands." },
  { brand: "Zara", company: "Industria de Diseño Textil (ADR)", ticker: "IDEXY", mcc: [5651],
    patterns: ["ZARA"], note: "Inditex trades in the US as an ADR." },
  { brand: "Uniqlo", company: "Fast Retailing Co. (ADR)", ticker: "FRCOY", mcc: [5651],
    patterns: ["UNIQLO"] },
  { brand: "IKEA", company: "Ingka Group (private)", ticker: "", mcc: [5712],
    patterns: ["IKEA"], note: "Privately held foundation structure." },
  { brand: "Sephora", company: "LVMH (ADR)", ticker: "LVMUY", mcc: [5977],
    patterns: ["SEPHORA"], note: "Sephora is an LVMH brand." },
  { brand: "Ulta Beauty", company: "Ulta Beauty Inc.", ticker: "ULTA", mcc: [5977],
    patterns: ["ULTA", "ULTA BEAUTY"] },
  { brand: "CVS", company: "CVS Health Corp.", ticker: "CVS", mcc: [5912],
    patterns: ["CVS", "CVS PHARMACY"] },
  { brand: "Kroger", company: "The Kroger Co.", ticker: "KR", mcc: [5411],
    patterns: ["KROGER", "RALPHS", "FRED MEYER", "KING SOOPERS"],
    note: "Ralphs / Fred Meyer / King Soopers are Kroger banners." },

  // ---- mobility, travel, delivery ----------------------------------------
  { brand: "Uber", company: "Uber Technologies Inc.", ticker: "UBER", mcc: [4121, 5812],
    patterns: ["UBER", "UBER EATS", "UBER TRIP", "UBEREATS"] },
  { brand: "Lyft", company: "Lyft Inc.", ticker: "LYFT", mcc: [4121],
    patterns: ["LYFT"] },
  { brand: "DoorDash", company: "DoorDash Inc.", ticker: "DASH", mcc: [5812, 5814],
    patterns: ["DOORDASH", "DD DOORDASH"] },
  { brand: "Airbnb", company: "Airbnb Inc.", ticker: "ABNB", mcc: [7011],
    patterns: ["AIRBNB", "AIRBNB COM"] },
  { brand: "Booking.com", company: "Booking Holdings Inc.", ticker: "BKNG", mcc: [7011, 4722],
    patterns: ["BOOKING COM", "BOOKING", "PRICELINE", "OPENTABLE", "KAYAK"],
    note: "Booking.com / Priceline / OpenTable / Kayak share one parent." },
  { brand: "Delta", company: "Delta Air Lines Inc.", ticker: "DAL", mcc: [3058, 4511],
    patterns: ["DELTA", "DELTA AIR"] },
  { brand: "United Airlines", company: "United Airlines Holdings", ticker: "UAL", mcc: [3000, 4511],
    patterns: ["UNITED AIRLINES", "UNITED AIR"] },
  { brand: "Marriott", company: "Marriott International Inc.", ticker: "MAR", mcc: [3509, 7011],
    patterns: ["MARRIOTT", "COURTYARD", "RESIDENCE INN", "WESTIN", "SHERATON"],
    note: "Courtyard / Residence Inn / Westin / Sheraton are Marriott flags." },
  { brand: "Tesla", company: "Tesla Inc.", ticker: "TSLA", mcc: [5511, 5552, 5541],
    patterns: ["TESLA", "TESLA SUPERCHARGER", "TSLA"] },
  { brand: "Shell", company: "Shell plc", ticker: "SHEL", mcc: [5541, 5542],
    patterns: ["SHELL", "SHELL OIL", "SHELL SERVICE"] },
  { brand: "Chevron", company: "Chevron Corp.", ticker: "CVX", mcc: [5541, 5542],
    patterns: ["CHEVRON", "TEXACO"] },

  { brand: "Exxon", company: "Exxon Mobil Corp.", ticker: "XOM", mcc: [5541, 5542],
    patterns: ["EXXON", "EXXONMOBIL", "MOBIL"] },
  { brand: "Xfinity", company: "Comcast Corp.", ticker: "CMCSA", mcc: [4899, 4814],
    patterns: ["COMCAST", "XFINITY"],
    note: "Xfinity is Comcast's consumer brand — the descriptor rarely says Comcast." },
  { brand: "GameStop", company: "GameStop Corp.", ticker: "GME", mcc: [5734, 5732, 5999],
    patterns: ["GAMESTOP", "GAME STOP"] },
  { brand: "GEICO", company: "Berkshire Hathaway", ticker: "BRK.B", mcc: [6300, 5960],
    patterns: ["GEICO"],
    note: "GEICO is wholly owned by Berkshire Hathaway — an insurance premium buys you BRK.B." },
  { brand: "Dairy Queen", company: "Berkshire Hathaway", ticker: "BRK.B", mcc: [5814],
    patterns: ["DAIRY QUEEN", "DQ GRILL"],
    note: "Also a Berkshire subsidiary. Two unrelated-looking descriptors, one ticker." },
  { brand: "Pepsi", company: "PepsiCo Inc.", ticker: "PEP", mcc: [5499, 5814],
    patterns: ["PEPSI", "GATORADE", "FRITO LAY"] },

  // ---- private-but-tokenized: the case TradFi cannot serve ---------------
  { brand: "Starlink", company: "Space Exploration Technologies", ticker: "SPCX", mcc: [4899, 4814],
    patterns: ["STARLINK", "SPACEX"],
    note: "SpaceX is private and unavailable in any brokerage account — but a tokenized SPCX exists onchain. This is the one mapping TradFi structurally cannot do." },

  // ---- fintech / crypto ---------------------------------------------------
  { brand: "Shopify", company: "Shopify Inc.", ticker: "SHOP", mcc: [5999, 7372],
    patterns: ["SHOPIFY", "SHOPIFY COM"] },
  { brand: "Coinbase", company: "Coinbase Global Inc.", ticker: "COIN", mcc: [6051],
    patterns: ["COINBASE"] },
  { brand: "Robinhood", company: "Robinhood Markets Inc.", ticker: "HOOD", mcc: [6211],
    patterns: ["ROBINHOOD"] },
  { brand: "PayPal", company: "PayPal Holdings Inc.", ticker: "PYPL", mcc: [6012],
    patterns: ["PAYPAL INC", "PYPL"],
    note: "Careful: 'PAYPAL *MERCHANT' is a processor prefix, not a purchase from PayPal. Normalization strips it before matching." },
];

/**
 * MCC -> the closest available basket.
 *
 * This rung used to map MCCs to SPDR sector ETFs (XLY, XLP, XLE, XLK…), which
 * is the right shape for the product: a neighbourhood coffee shop has no stock,
 * but it *is* consumer-staples exposure. xStocks issues no sector ETFs — only
 * SPY, QQQ, VTI and GLD — so the ladder has nowhere granular to land and
 * collapses to broad market, with QQQ as the one honest refinement for
 * tech and digital spend.
 *
 * Restoring sector granularity means adding a second issuer, not a smarter
 * matcher. That is the single highest-leverage change to this file.
 */
export const MCC_SECTOR: Record<number, { ticker: string; label: string }> = {
  5732: { ticker: "QQQ", label: "Nasdaq-100" },
  5734: { ticker: "QQQ", label: "Nasdaq-100" },
  7372: { ticker: "QQQ", label: "Nasdaq-100" },
  5815: { ticker: "QQQ", label: "Nasdaq-100" },
  5817: { ticker: "QQQ", label: "Nasdaq-100" },
  5818: { ticker: "QQQ", label: "Nasdaq-100" },
  4899: { ticker: "QQQ", label: "Nasdaq-100" },
};

/** Last rung: the whole market. */
export const INDEX_FALLBACK = "SPY";

export const MCC_LABELS: Record<number, string> = {
  3000: "Airline", 3058: "Airline", 3509: "Hotel",
  4121: "Taxi / Rideshare", 4511: "Airline", 4722: "Travel Agency",
  4814: "Telecom", 4899: "Cable / Streaming",
  5200: "Home Supply", 5211: "Building Materials", 5300: "Wholesale Club",
  5310: "Discount Store", 5311: "Department Store", 5411: "Grocery",
  5499: "Convenience Store", 5511: "Car Dealer", 5552: "EV Charging",
  5541: "Gas Station", 5542: "Automated Fuel", 5651: "Clothing",
  5661: "Shoe Store", 5712: "Furniture", 5732: "Electronics",
  5734: "Computer Software", 5812: "Restaurant", 5814: "Fast Food",
  5815: "Digital Goods", 5817: "Digital Apps", 5818: "Digital Services",
  5941: "Sporting Goods", 5942: "Book Store", 5977: "Cosmetics",
  5960: "Insurance", 6300: "Insurance",
  5999: "Misc Retail", 6012: "Financial Institution", 6051: "Quasi-Cash",
  6211: "Securities Broker", 7011: "Hotel", 7311: "Advertising",
  7372: "Computer Services", 7996: "Amusement", 9399: "Government Services",
};
