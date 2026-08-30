# South Africa CCTV source pack — research notes

First-pass customisation for the wit-wolf fork deliberately **does not** ship a ZA
CCTV catalog. Existing Austin / Caltrans / TfL packs stay unchanged.

## Searched

| Source | What exists | Why skipped |
| --- | --- | --- |
| **SANRAL i-TRAFFIC** ([i-traffic.co.za](https://www.i-traffic.co.za/cctv), [API docs](https://www.i-traffic.co.za/developers/help)) | REST `GetCameras` catalog for national freeway cameras | Requires a registered **developer key**; throttled (10 calls / 60 s). Terms/redistribution for frame embedding are not a clear keyless open-data license like Austin / TfL / Caltrans. |
| **City of Cape Town Open Data / EGIS** | Transport GIS (roads, MyCiTi, etc.) | No public traffic-camera catalog or frame API found in the open-data / MapServer layers reviewed. |
| **Gauteng / municipal portals** | General open-data and traffic info sites | No documented public CCTV catalog + image endpoints matching the `config/cctv_sources.*.json` / live-pack pattern. |

## When to add a pack later

Add `config/cctv_sources.za.json` (and/or a live loader in `vite.config.js`) only when there is:

1. A real public municipal / open-data camera catalog URL,
2. Documented terms that allow embedding frames with attribution, and
3. Stable lat/lon (+ optional heading) fields that normalize like Austin / TfL / Caltrans.

Do **not** scrape private or undocumented camera streams.
