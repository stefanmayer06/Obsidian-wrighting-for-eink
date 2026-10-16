# Privacy policy – Ink Notebook Cloud

> **Template.** Fill in everything in [brackets], check the facts marked *(check)*, and have it reviewed before publishing. It describes how the service is built in this repository; if you change the service, update the policy. This is not legal advice.

*Last updated: [date]*

## Who is responsible

[Your full name or business name]
[Postal address]
[E-mail address]

## What this policy covers

This policy covers **Ink Notebook Cloud**, the optional paid handwriting recognition for the Ink Notebook plugin for Obsidian. The plugin itself runs on your device; your notes stay in your vault. Only when you use Ink Notebook Cloud does the plugin send data to us, as described below.

## What we process, why, and for how long

**Handwriting images.** To transcribe a page, the plugin renders the handwriting strokes of the area you changed as a black-and-white image (never typed text, PDF pages or the paper background) and sends it to our server, which passes it to Microsoft Azure AI Vision and returns the recognised text to you. We do not store the images or the recognised text. Microsoft processes them in [West Europe] and deletes them within 24 hours; they are not used for any other purpose. Legal basis: performance of our contract with you (Art. 6(1)(b) GDPR).

**Your license key.** To check your subscription, our server asks Polar whether your key is valid. We store a one-way hash (SHA-256) of the key, Polar's identifier for your license, whether it is active and when it was last checked. Legal basis: Art. 6(1)(b) GDPR. Kept while your subscription is active and for [12 months] after it ends.

**Usage counts.** We count how many recognitions each license uses per month, to apply the monthly allowance. Legal basis: Art. 6(1)(b) GDPR. Kept for [12 months].

**Server logs.** Our hosting provider records technical request data (time, address requested, status, IP address) to run the service and keep it secure. Legal basis: our legitimate interest in a secure, working service (Art. 6(1)(f) GDPR). Kept for [the log retention of the Supabase plan, e.g. 7 days] *(check)*.

**Purchases.** Subscriptions are sold by **Polar** ([Polar Software Inc.](https://polar.sh)) as merchant of record. Polar processes your name, e-mail address, billing details and payment information under [its own privacy policy](https://polar.sh/legal/privacy) *(check link)*. We receive from Polar [your name, e-mail address and country] to manage your subscription and answer support requests.

We do not use your data for advertising, do not sell it and do not use it to train AI models. The plugin contains no tracking or analytics.

## Service providers

| Provider | What for | Where |
| --- | --- | --- |
| Supabase, Inc. | Server and database | Frankfurt, Germany (EU) |
| Microsoft Ireland Operations Ltd. (Azure AI Vision) | Handwriting recognition | [West Europe] |
| Polar Software Inc. | Sales, payments, invoices, taxes (merchant of record, its own responsibility) | [check] |

Supabase and Microsoft process data on our behalf under data processing agreements. [Describe the safeguards for transfers outside the EU, e.g. the EU–US Data Privacy Framework or standard contractual clauses] *(check)*.

## Your rights

You have the right to access, correct and delete your data, to restrict or object to processing and to data portability. Write to [e-mail address]. You also have the right to lodge a complaint with a data protection authority, for example [your national authority].

To delete everything we hold about your license, cancel your subscription and ask us to delete your data; we then remove the license record and usage counts.
