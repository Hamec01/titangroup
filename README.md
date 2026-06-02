# titangroup

## Admin portal

- Hidden URL: `/ship-admin-portal`
- Not linked in navigation or sitemap
- Login only with password (`ADMIN_PASSWORD`)
- Registration is disabled

### Setup

1. Copy `.env.example` to `.env.local`
2. Fill in admin credentials, Cloudinary keys, and optionally Supabase keys for production persistence
3. Run `npm run dev`
4. Open `/ship-admin-portal` directly

### What admin can do

- Upload service images to Cloudinary
- Remove images from service sections
- Edit service descriptions in EN and FI
- Add and remove open vacancies (role, location, duration, description, posted date)
- Changes are reflected on public service cards without redeploy

## Career section

- Public `Career` section is available on the main page after `Contact`
- Includes application form and live `Open vacancies` list from `/api/vacancies`

### Production storage

- Cloudinary stores the files
- Supabase stores editable service descriptions, image lists, and vacancies
- If Supabase env vars are not set, the app falls back to local JSON files for development only