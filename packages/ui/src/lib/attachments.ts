import { AttachmentRef } from '@agent-os/shared';
import { gatewayHttpOrigin } from './gatewayOrigin';

const GATEWAY_ORIGIN = gatewayHttpOrigin();

export async function uploadFile(file: File): Promise<AttachmentRef> {
  const formData = new FormData();
  formData.append('file', file, file.name);
  const res = await fetch(`${GATEWAY_ORIGIN}/api/files`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    throw new Error(`Upload failed: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as AttachmentRef;
}
