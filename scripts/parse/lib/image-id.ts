// Генерация стабильных image_id. Правила из ТЗ:
//   image_id = <card.id>_<index>, index от 0
//   cover — всегда _0, галерея идёт _1, _2, ...

export function makeImageId(cardId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`index должен быть неотрицательным целым, получено ${index}`);
  }
  return `${cardId}_${index}`;
}

export function extensionFromContentType(contentType: string): string {
  const mime = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (mime) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return '';
  }
}
