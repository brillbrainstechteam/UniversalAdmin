import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = ['/login', '/accept-invite'];

/** UX redirect only; the API enforces the buyer session and company scope on every request. */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (PUBLIC.some((p) => pathname.startsWith(p))) return NextResponse.next();
  if (!request.cookies.has('uc_b_sess')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] };
