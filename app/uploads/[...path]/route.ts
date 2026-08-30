import { readLocalServiceImage } from '../../../lib/local-image-storage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const revalidate = 0;

type UploadRouteContext = {
  params: Promise<{
    path: string[];
  }>;
};

export async function GET(_request: Request, { params }: UploadRouteContext) {
  const resolvedParams = await params;
  const image = await readLocalServiceImage(resolvedParams.path);

  if (!image) {
    return new Response('Not found', {
      status: 404,
      headers: {
        'Cache-Control': 'no-store'
      }
    });
  }

  return new Response(image.body, {
    headers: {
      'Content-Type': image.contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: image.etag,
      // R07-B — never let a stored upload be interpreted as anything but the declared image type,
      // and render it in place rather than as a top-level document.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${image.filename.replace(/[^\w.-]/g, '_')}"`
    }
  });
}
