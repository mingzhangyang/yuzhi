import { handleIcsRequest } from '../../shared/icsProxy';

// GET /api/ics?url=<订阅链接>：替浏览器取回 .ics，只转发，不保存
export const onRequestGet: PagesFunction = ({ request }) => handleIcsRequest(request.url);
