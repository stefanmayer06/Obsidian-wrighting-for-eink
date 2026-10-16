# Running Ink Notebook Cloud

Ink Notebook Cloud is the optional paid subscription for handwriting recognition: subscribers paste a license key instead of creating their own Azure resource. This page is for whoever runs the service.

```
 Ink Notebook plugin ──PNG + license key──▶ Supabase Edge Function "ocr" (Frankfurt)
                                              │  ├─ Polar: is this license key active?   (cached 6 h)
                                              │  ├─ Postgres: count this month's requests per license
                                              │  └─ Azure AI Vision: read the handwriting (your key)
                      ◀────────text──────────┘
```

- **Code:** `supabase/functions/ocr/` (server), `supabase/migrations/` (database), `src/core/cloud.ts` + `src/obsidian/cloudClient.ts` (plugin).
- **Project:** Supabase project `ink-notebook-cloud` (ref `qbqbrchglnowdbagrrjr`, eu-central-1), organisation MayerDigial.
- **Endpoint:** `https://qbqbrchglnowdbagrrjr.supabase.co/functions/v1/ocr` – built into the plugin (`CLOUD_ENDPOINT`).
- **Switched off until configured:** until the Azure and Polar secrets and `CHECKOUT_URL` are set, `…/ocr/info` answers `"available": false` and the plugin does not offer the cloud at all. Releasing the plugin before launch is safe.

## 1. Azure (the recognition)

1. In the [Azure portal](https://portal.azure.com/#create/Microsoft.CognitiveServicesComputerVision) create a **Computer Vision** resource just for the service.
   - Region: **West Europe** (EU, close to the server). If recognition later fails with "not supported", set the secret `AZURE_API` to `v3.2`.
   - Pricing tier: **Standard S1**. The free F0 tier allows only 20 requests per minute and 5,000 per month for *all* subscribers together – fine for testing, not for customers.
2. Resource → **Keys and Endpoint**: copy the endpoint and KEY 1.
3. Cost Management → **Budgets**: add a monthly budget with an e-mail alert, so a bug or abuse can't run up a surprise bill.

## 2. Polar (the subscription)

Start in the **sandbox** ([sandbox.polar.sh](https://sandbox.polar.sh)) – test cards, no real money – and repeat the same steps on [polar.sh](https://polar.sh) to go live.

1. Create an account and an organisation.
2. **Benefits → New benefit → License Keys**: prefix e.g. `INK`; *no* expiry, *no* activation limit and *no* usage limit (the server counts usage itself; with an activation limit Polar would require activation ids the plugin does not send).
3. **Products → New product**: e.g. "Ink Notebook Cloud", monthly recurring price, and attach the License Keys benefit. Polar revokes the key automatically when a subscription is cancelled.
4. Create a **checkout link** for the product.
5. Note your **organisation ID** (organisation settings) and the link to your **customer portal** (where customers see their key and cancel).

Polar is the merchant of record: it charges customers, sends invoices and handles VAT/sales tax. You receive payouts.

## 3. Secrets

Set these in the Supabase dashboard → [Edge Functions → Secrets](https://supabase.com/dashboard/project/qbqbrchglnowdbagrrjr/functions/secrets). They take effect immediately, no redeploy needed.

| Secret | Value |
| --- | --- |
| `AZURE_ENDPOINT` | Azure endpoint, e.g. `https://ink-cloud.cognitiveservices.azure.com` |
| `AZURE_KEY` | Azure KEY 1 |
| `POLAR_ORGANIZATION_ID` | Polar organisation ID |
| `CHECKOUT_URL` | Polar checkout link (https). Without it the plugin doesn't offer the cloud to new users; existing keys keep working |
| `PORTAL_URL` | Polar customer portal link (https) – shown as "Manage subscription" |
| `PRIVACY_URL` | Your privacy policy (https) – shown in the plugin |
| `MONTHLY_LIMIT` | Recognitions per subscriber and month (default 2000). Each changed writing area of a page is one recognition |
| `POLAR_API_URL` | `https://sandbox-api.polar.sh` while testing with the sandbox; remove it to go live |
| `POLAR_BENEFIT_ID` | Optional: only accept keys of this License Keys benefit |
| `AZURE_API` | Optional: `v3.2` if Image Analysis 4.0 is not available in your Azure region |

## 4. Test it

```bash
U=https://qbqbrchglnowdbagrrjr.supabase.co/functions/v1/ocr
curl $U/info                                             # "available": true once configured
curl -H "X-License-Key: INK_…" $U/status                 # after a test purchase in the sandbox
curl -H "X-License-Key: INK_…" --data-binary @page.png $U/recognize
```

Then in Obsidian: *Settings → Ink Notebook → Handwriting recognition → Service: Ink Notebook Cloud*, paste the key, press **Check**, write something and flip to the text page.

## 5. Before the first real customer

- [ ] **Supabase Pro plan.** Free projects are paused after a week of low database activity (Supabase e-mails a warning first) – a paused project means the service is down for every subscriber. Paid projects are never paused.
- [ ] **Polar production**: repeat step 2 on polar.sh, update `POLAR_ORGANIZATION_ID`, `CHECKOUT_URL`, `PORTAL_URL`, remove `POLAR_API_URL`.
- [ ] **Privacy policy**: fill in [privacy-policy-template.md](privacy-policy-template.md), publish it (e.g. as a page in this repository) and set `PRIVACY_URL`. Accept Supabase's DPA (dashboard → organisation → legal documents); Microsoft's DPA is part of the Azure product terms.
- [ ] **Terms of service**: what the subscription includes (the monthly allowance), that recognition can make mistakes, availability, how to cancel.
- [ ] **Taxes/business**: Polar handles VAT on sales, but the payouts are your income – register as self-employed/a business where you live and declare it.
- [ ] **Release the plugin** with the cloud code (bump the version, see *Releasing* in the README).

## Costs

Per month: Supabase Pro (fixed) + Azure (recognitions × Azure's price per 1,000 for your region and tier – see the [Azure pricing page](https://azure.microsoft.com/pricing/details/computer-vision/)) + Polar's fee per payment. A subscriber who uses the whole allowance costs `MONTHLY_LIMIT / 1000 × Azure price`; most use far less. Set the price so that a handful of subscribers covers the fixed cost.

## Running it

- **Logs:** dashboard → Edge Functions → `ocr` → Logs. The server logs problems with Azure and Polar (prefixed `ocr:`), never images or keys.
- **Usage:**
  ```sql
  select month, count(*) as subscribers_using_it, sum(requests) as recognitions
  from license_usage group by month order by month desc;
  ```
- **Stop new sign-ups:** remove `CHECKOUT_URL`. **Change the allowance:** `MONTHLY_LIMIT`.
- **Deploy changes** (Supabase CLI, from the repository root):
  ```bash
  supabase link --project-ref qbqbrchglnowdbagrrjr
  supabase functions deploy ocr        # supabase/config.toml turns JWT verification off for it
  supabase db push                     # new files in supabase/migrations
  ```
  Run `npm test` first – `tests/cloudServer.test.ts` covers the server logic, and the e2e suite runs the real server code against the plugin in Obsidian (`e2e/scripts/mock-cloud.mjs`).
- **Leftovers:** the first migration created a `usage` table and two functions that the second replaced; they are empty and unused and can be dropped:
  ```sql
  drop function public.consume_ocr_request(text, integer);
  drop function public.refund_ocr_request(text);
  drop table public.usage;
  ```

## How the server decides

- A license key is checked with Polar, then trusted for 6 hours (a key reported inactive is re-checked after 10 minutes, so a renewal works quickly). Keys are stored only as SHA-256 hashes; keys Polar has never confirmed are not stored.
- If Polar can't be reached, a key that was active within the last 72 hours keeps working.
- Usage is counted per Polar license id, so rotating a key in the customer portal doesn't reset the allowance. A failed recognition is not counted.
- Images (PNG/JPEG, up to 8 MB) are passed to Azure and not stored; Azure deletes input and results within 24 hours.
- One key used on several devices shares one allowance – that's intended (the same person on a phone and a tablet).
