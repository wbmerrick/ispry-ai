# iSpry follow-ups

From a pass on the live site. Most urgent first. Done items are already in the product; the rest are still open.

## Fix now

- [x] Logged-in messages were visible without a real session. The membership banner only appears after this browser returns from Stripe checkout, and Sign out stays hidden until an account session exists.
- [x] Medicare. The site does not enroll Medicare beneficiaries and does not bill Medicare. Accepting Medicare members later still needs a healthcare attorney, because opting out would touch hospitalist and SNF/ACO REACH work.
- [x] NAD+, sermorelin, and GLP-1 are off the iSpry fast track and out of Spry's offers. There is no SpryMD site in this repo to link, so they were removed here instead of sent to a different practice.

## Conversion

- [x] One-time visit at $49 that can upgrade to membership. Checkout goes live when `STRIPE_VISIT_URL` is a one-time Stripe Payment Link (not the $100 subscription).
- [x] Same-day physician review if the case is submitted by 6 pm Central. After that, the next morning.
- [x] Two messages to Spry before an account. The third message asks for the account. Emergencies still skip the account.
- [x] Plain words on fast track, including "Fear of flying," and no question mark on those buttons.

## Trust

- [x] Tennessee license 4267 (the number on NPI 1497231054) links to the Tennessee Department of Health verification page, and (731) 415-0724 is in the header.
- [x] "What we can't treat" is on the homepage.
- [x] No review block. Real reviews can be added when they exist. None were invented.

## Growth

- [x] Pages for online UTI treatment in Tennessee, sore throat treatment in Tennessee, and telehealth in Jackson, TN, plus a West Tennessee care page and `sitemap.xml`.
- [ ] Google Business Profile still has to be created in the Google account for the practice. Use the practice name, (731) 415-0724, https://ispry.ai/, and a West Tennessee service area. Do not publish a home street address.
- [x] Rural line: no 45-minute drive to urgent care.
- [x] HSA/FSA note, and a small-employer plan for West TN businesses reached at (731) 415-0724.
- [x] No Meta Pixel or Google Analytics. Vercel Web Analytics stays, and events no longer include the condition.
