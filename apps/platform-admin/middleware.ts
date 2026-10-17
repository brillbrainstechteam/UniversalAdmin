import { NextResponse, type NextRequest } from 'next/server';

/** UX redirect only; every /v1/platform call is authorized server-side. */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith('/login')) return NextResponse.next();
  if (!request.cookies.has('uc_p_sess')) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!api|_next|favicon.ico).*)'] };
