import { NextRequest, NextResponse } from 'next/server';
import { isAdminRequestAuthenticated } from '../../../../lib/admin-auth';
import { rejectIfCsrfMissing } from '../../../../lib/csrf';
import { deleteLocalServiceImage, saveLocalServiceImage } from '../../../../lib/local-image-storage';
import {
  addServiceImage,
  getStoredServiceImages,
  isServiceSection,
  removeServiceImage
} from '../../../../lib/service-images-store';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function unauthorizedResponse() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

export async function GET(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const images = await getStoredServiceImages();
  return NextResponse.json(images);
}

export async function POST(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const sectionRaw = formData.get('section');
  const fileRaw = formData.get('file');

  if (typeof sectionRaw !== 'string' || !isServiceSection(sectionRaw)) {
    return NextResponse.json({ error: 'Invalid section' }, { status: 400 });
  }

  if (!(fileRaw instanceof File)) {
    return NextResponse.json({ error: 'File is required' }, { status: 400 });
  }

  let uploaded: Awaited<ReturnType<typeof saveLocalServiceImage>>;
  try {
    // R07-B — saveLocalServiceImage rejects bad input with a curated, safe message (wrong format,
    // GIF, too large, corrupt, write failure). Treat every rejection as a 400 client error.
    uploaded = await saveLocalServiceImage(sectionRaw, fileRaw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The image could not be uploaded.';
    return NextResponse.json({ error: message }, { status: 400 });
  }

  try {
    const images = await addServiceImage(sectionRaw, {
      url: uploaded.url,
      publicId: uploaded.publicId
    });
    return NextResponse.json(images);
  } catch (error) {
    console.error(`admin/images: index update failed [${(error as { code?: string })?.code ?? 'UNKNOWN'}]`);
    return NextResponse.json({ error: 'The image was uploaded but the catalogue could not be updated.' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isAdminRequestAuthenticated(request)) {
    return unauthorizedResponse();
  }

  const csrf = rejectIfCsrfMissing(request);
  if (csrf) return csrf;

  let body: { section?: string; publicId?: string; url?: string };
  try {
    body = (await request.json()) as { section?: string; publicId?: string; url?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  try {
    if (typeof body.section !== 'string' || !isServiceSection(body.section)) {
      return NextResponse.json({ error: 'Invalid section' }, { status: 400 });
    }

    const publicId = typeof body.publicId === 'string' ? body.publicId : undefined;
    const url = typeof body.url === 'string' ? body.url : undefined;

    if (!publicId && !url) {
      return NextResponse.json({ error: 'Image identifier is required' }, { status: 400 });
    }

    if (publicId) {
      await deleteLocalServiceImage(publicId);
    }

    const images = await removeServiceImage(body.section, { publicId, url });
    return NextResponse.json(images);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Delete failed';
    return NextResponse.json({ error: `Delete failed: ${message}` }, { status: 500 });
  }
}
