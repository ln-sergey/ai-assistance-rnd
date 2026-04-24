// Общие типы парсеров — совпадают с product_card.schema.json.
// _meta — side-channel, валидатор смотрит только на .card.

export interface ProductCard {
  id: string;
  product_type: 'tour' | 'excursion' | 'event';
  title: string;
  short_description: string;
  full_description: string;
  program_items: Array<{ order: number; title: string; description: string }>;
  services: Array<{ name: string; description: string }>;
  location: {
    address: string;
    route_comment: string;
    meeting_point_comment: string;
  };
  contacts_block: { public_comment: string };
  schedule: {
    format: 'once' | 'recurring' | 'ondemand';
    dates?: string[];
    duration_minutes?: number;
  };
  age_restriction?: string | null;
  group_size?: { min?: number; max?: number } | null;
  languages?: string[];
  images: Array<{
    image_id: string;
    role: 'cover' | 'gallery';
    caption?: string | null;
  }>;
}

export interface CardRecord {
  card: ProductCard;
  _meta: {
    source_site: string;
    source_url: string;
    fetched_at: string;
    parser_version: string;
    json_ld_found: boolean;
    warnings: string[];
  };
}

export interface ImageRecord {
  image_id: string;
  linked_card_id: string;
  role: 'cover' | 'gallery';
  caption: string | null;
  source_url: string;
  file_path: string;
  _meta: {
    queued_at: string;
  };
}
