# iSpry follow-ups

From a pass on the live site. Most urgent first. Done items are already in the product; the rest are still open.

## Fix now

- [x] Logged-in messages were visible without a real session. The membership banner only appears after this browser returns from Stripe checkout, and Sign out stays hidden until an account session exists.
- [ ] Check Medicare before marketing to seniors. Charging Medicare patients $100/month for services Medicare covers usually requires opting out of Medicare, and opting out applies to everything billed, including hospitalist and SNF/ACO REACH work. Get a healthcare attorney's read before taking Medicare members, or limit their membership to non-covered services.
- [ ] Trim the wellness add-ons. NAD+ and sermorelin carry compounding and regulatory questions and dilute the "real doctor, real problems" message. Consider moving them, and GLP-1, to SpryMD so the two sites don't compete.

## Conversion

- [x] One-time visit at $49 that can upgrade to membership. Checkout goes live when `STRIPE_VISIT_URL` is a one-time Stripe Payment Link (not the $100 subscription).
- [ ] Promise a response time, for example "Reviewed same day if submitted by 6 pm."
- [ ] Let people send 1–2 messages to Spry before creating an account.
- [ ] Use plain words: "fear of flying" instead of "Aviophobia," and drop the question mark on every fast-track item.

## Trust

- [ ] Add the Tennessee license number with a link to the state verification page, plus the 731 phone/text line in the header.
- [ ] Add a short "What we can't treat" list.
- [ ] Add real reviews once they exist. Leave that space empty until then.

## Growth

- [ ] Build SEO pages by condition and city, such as "Online UTI treatment Tennessee" or "Telehealth Jackson TN," and set up a Google Business Profile.
- [ ] Lean into the rural angle: "No 45-minute drive to an urgent care."
- [ ] Mention HSA/FSA eligibility, and offer a small-employer plan for West TN businesses.
- [ ] Be careful with tracking. Meta Pixel or Google Analytics on health pages can create HIPAA problems under HHS guidance. Use a privacy-safe analytics tool instead.
