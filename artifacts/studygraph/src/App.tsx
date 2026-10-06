import { useEffect, useRef, useState } from 'react';
import { ClerkProvider, SignIn, SignUp, UserButton, useAuth } from '@clerk/react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import {
  ArrowLeft, ArrowRight, BookOpen, CheckCircle2, ChevronRight,
  CircleAlert, Clock3, FileText, Film, FolderPlus, GraduationCap, LoaderCircle,
  Plus, RefreshCw, ShieldCheck, Trash2, Upload, X, Youtube,
} from 'lucide-react';
import {
  getListCoursesQueryKey, getListSourcesQueryKey, getGetCourseSummaryQueryKey,
  getGetSourceQueryKey,
  useAddYoutubeSource, useCreateCourse, useDeleteSource, useListCourses, useListSources,
  useRegisterUploadedSource, useRequestUploadUrl,
  useGetSource, useGetCourseSummary,
} from '@workspace/api-client-react';
import type { Course, Source, SourceSourceType, SourceStatus } from '@workspace/api-client-react';
import NotFound from '@/pages/not-found';
import { ErrorBoundary } from '@/components/error-boundary';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 12_000 } } });
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');
const signInPath = '/sign-in';
const signUpPath = '/sign-up';
const clerkSignInPath = `${BASE}/sign-in`;
const clerkSignUpPath = `${BASE}/sign-up`;
const sourceAccept = '.pdf,.pptx,.mp4,.mov,.m4v,.webm,.avi,.mkv,.mpeg,.mpg';
const sameOriginRequest = { credentials: 'same-origin' as const };

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <Link href="/" aria-label="StudyGraph home" className={`inline-flex items-center gap-2.5 ${inverse ? 'text-[#f5f0e5]' : 'text-[#25473c]'}`}>
    <span className={`grid h-9 w-9 place-items-center rounded-xl ${inverse ? 'bg-[#dfbd83] text-[#25473c]' : 'bg-[#25473c] text-[#f6f0e3]'}`}><BookOpen size={18} strokeWidth={1.8} /></span>
    <span className="text-[19px] font-semibold tracking-[-.055em]">studygraph<span className="text-[#c29a61]">.</span></span>
  </Link>;
}

function Landing() {
  const { isLoaded, isSignedIn } = useAuth();
  const [, navigate] = useLocation();
  useEffect(() => { if (isLoaded && isSignedIn) navigate('/user-portal'); }, [isLoaded, isSignedIn, navigate]);
  return <main className="grain overflow-hidden text-[#25473c]">
    <header className="relative z-10 mx-auto flex max-w-[1240px] items-center justify-between px-6 py-5 lg:px-10">
      <Brand />
      <nav aria-label="Main navigation" className="flex items-center gap-3">
        <a href="#how-it-works" className="hidden px-4 py-2 text-sm text-[#60756b] hover:text-[#25473c] sm:block">How it works</a>
        <Link href={signInPath} className="rounded-full px-4 py-2 text-sm font-semibold hover:bg-[#e9e6dc]" data-testid="link-sign-in">Sign in</Link>
        <Link href={signUpPath} className="rounded-full bg-[#25473c] px-5 py-2.5 text-sm font-semibold text-[#faf6eb] transition hover:-translate-y-0.5" data-testid="link-sign-up">Create account</Link>
      </nav>
    </header>
    <section className="relative mx-auto grid min-h-[640px] max-w-[1240px] items-center gap-10 px-6 pb-20 pt-12 lg:grid-cols-[1.05fr_.95fr] lg:px-10 lg:pb-28 lg:pt-16">
      <div className="enter relative z-10 max-w-[600px]">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-[#d8d5c9] bg-[#fbf9f2] px-3 py-1.5 font-mono-ui text-[10px] uppercase tracking-[.14em] text-[#65776c]"><span className="status-dot bg-[#c29a61]" /> A clearer way through your course material</div>
        <h1 className="font-editorial text-[clamp(3.5rem,7.6vw,6.5rem)] leading-[.93] tracking-[-.055em]">Study from the<br /><em className="font-medium text-[#b3824e]">source.</em></h1>
        <p className="mt-7 max-w-[480px] text-lg leading-8 text-[#64766c]">Turn lecture slides, readings and recordings into organized course material you can trace back to where it came from.</p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link href={signUpPath} className="group inline-flex items-center gap-3 rounded-full bg-[#25473c] px-6 py-3.5 text-sm font-semibold text-[#faf6eb] transition hover:-translate-y-0.5" data-testid="hero-get-started">Start your library <ArrowRight size={16} className="transition-transform group-hover:translate-x-1" /></Link>
          <span className="text-sm text-[#718077]">Free to begin · your materials stay yours</span>
        </div>
        <div className="mt-14 flex items-center gap-4 border-t border-[#dfddd3] pt-5 text-[11px] font-mono-ui uppercase tracking-[.12em] text-[#738178]"><ShieldCheck size={17} className="text-[#567866]" /> Every study unit stays connected to its source</div>
      </div>
      <div className="enter-delay relative mx-auto w-full max-w-[530px] lg:ml-auto">
        <div className="absolute -right-8 -top-9 h-44 w-44 rounded-full border border-[#d8c8aa] opacity-50" />
        <div className="absolute -bottom-7 -left-6 h-24 w-24 rounded-full bg-[#e8dfce]" />
        <div className="paper-grid relative rounded-[28px] border border-[#dcd9ce] bg-[#f8f6ed] p-4 shadow-[0_22px_70px_rgba(41,62,50,.10)] sm:p-7">
          <div className="flex items-center justify-between border-b border-[#e5e2d8] pb-4">
            <div><div className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#8b9185]">Course / 02</div><h2 className="mt-1 font-editorial text-2xl">Cellular biology</h2></div>
            <div className="rounded-full bg-[#e6eee5] px-3 py-1.5 font-mono-ui text-[9px] uppercase tracking-widest text-[#52705b]">Library active</div>
          </div>
          <div className="mt-5 rounded-2xl border border-[#e5e0d4] bg-[#fffdf6] p-4">
            <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#f1e8d8] text-[#9b774c]"><FileText size={18} /></div><div className="min-w-0 flex-1"><div className="truncate text-sm font-semibold">Week 04 — membranes.pdf</div><div className="mt-1 text-xs text-[#828b80]">Lecture notes · 18 pages</div></div><CheckCircle2 size={18} className="text-[#5e806b]" /></div>
            <div className="mt-4 h-px bg-[#ebe8df]" />
            <div className="mt-4 flex justify-between font-mono-ui text-[9px] uppercase tracking-[.13em] text-[#8b9185]"><span>Processing status</span><span className="text-[#5d7a65]">Ready</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[#e8e6dc]"><div className="h-full w-full rounded-full bg-[#6c8a72]" /></div>
          </div>
          <div className="mt-3 rounded-2xl bg-[#26473c] p-5 text-[#f4f0e5]">
            <div className="flex items-center justify-between"><div className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#c2cabc]">Study unit · 03</div><span className="rounded-full border border-white/15 px-2 py-1 font-mono-ui text-[9px] text-[#d5c196]">Source linked</span></div>
            <h3 className="mt-4 font-editorial text-[26px] leading-tight">The membrane as a selective boundary</h3>
            <p className="mt-3 text-[13px] leading-6 text-[#d0d6ca]">Phospholipids form a bilayer that regulates movement in and out of the cell. Transport depends on molecule size, charge, and concentration gradient.</p>
            <div className="mt-5 flex items-center gap-2 border-t border-white/15 pt-3 text-[10px] text-[#d5c196]"><span className="h-1 w-1 rounded-full bg-[#d5c196]" /> Week 04 — membranes.pdf <span className="ml-auto text-[#b9c4b8]">p. 06</span></div>
          </div>
          <div className="mt-4 flex justify-between px-1 text-[10px] font-mono-ui uppercase tracking-[.13em] text-[#899085]"><span>1 source</span><span>12 units assembled</span></div>
        </div>
        <div className="absolute -right-5 top-[38%] hidden -rotate-3 rounded-xl border border-[#d8d2c2] bg-[#fffdf6] px-4 py-3 shadow-[0_12px_32px_rgba(41,62,50,.10)] sm:block"><div className="font-mono-ui text-[9px] uppercase tracking-wider text-[#848a7d]">Traceable by design</div><div className="mt-1 text-xs font-semibold text-[#385847]">Source → idea → study</div></div>
      </div>
    </section>
    <section className="border-y border-[#dedbd0] bg-[#eeece2]">
      <div className="mx-auto grid max-w-[1240px] gap-8 px-6 py-8 sm:grid-cols-3 lg:px-10">
        {['One home for each course', 'Sources stay visible', 'Status stays honest'].map((line, index) => <div key={line} className="flex items-center gap-4"><span className="font-mono-ui text-xs text-[#b3824e]">0{index + 1}</span><span className="text-sm font-medium text-[#445d4f]">{line}</span></div>)}
      </div>
    </section>
    <section id="how-it-works" className="mx-auto max-w-[1240px] px-6 py-24 lg:px-10 lg:py-32">
      <div className="grid gap-12 md:grid-cols-[.7fr_1.3fr]">
        <div><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#b3824e]">A more grounded study loop</div><h2 className="mt-5 max-w-sm font-editorial text-5xl leading-[.98] tracking-[-.04em]">From lecture file to learning map.</h2></div>
        <div className="divide-y divide-[#ddd9cc] border-y border-[#ddd9cc]">
          {[
            ['01', 'Bring your course material', 'Add PDFs, slide decks, lecture recordings, or a YouTube lecture to the right course.'],
            ['02', 'Follow processing as it happens', 'See each source move through its actual queue and processing steps. Failed files are called out clearly.'],
            ['03', 'Keep ideas tied to evidence', 'Study materials are organized around the source that informed them—not detached from it.'],
          ].map(([number, title, copy]) => <article className="grid gap-4 py-6 sm:grid-cols-[56px_1fr_1fr]" key={number}><span className="font-mono-ui text-xs text-[#b3824e]">{number}</span><h3 className="font-semibold tracking-[-.02em]">{title}</h3><p className="text-sm leading-6 text-[#6e7c71]">{copy}</p></article>)}
        </div>
      </div>
    </section>
    <section className="bg-[#25473c] px-6 py-20 text-[#f5f0e5]">
      <div className="mx-auto flex max-w-[1240px] flex-col items-start justify-between gap-8 md:flex-row md:items-end lg:px-10">
        <div><div className="font-mono-ui text-[10px] uppercase tracking-[.17em] text-[#d3bb8d]">Build a library you can trust</div><h2 className="mt-4 max-w-xl font-editorial text-5xl leading-[.98] tracking-[-.04em] sm:text-6xl">Your course, organized around what’s real.</h2></div>
        <Link href={signUpPath} className="inline-flex items-center gap-3 rounded-full bg-[#e5c58e] px-6 py-3.5 text-sm font-semibold text-[#25473c] transition hover:-translate-y-0.5" data-testid="footer-sign-up">Create your account <ArrowRight size={16} /></Link>
      </div>
    </section>
    <footer className="mx-auto flex max-w-[1240px] flex-col gap-4 px-6 py-7 text-xs text-[#7b8579] sm:flex-row sm:items-center sm:justify-between lg:px-10"><Brand /><span>StudyGraph · Study with a clear line back to the source.</span><Link href={signInPath} className="hover:text-[#25473c]">Sign in</Link></footer>
  </main>;
}

function AuthPages({ kind }: { kind: 'sign-in' | 'sign-up' }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [, navigate] = useLocation();
  useEffect(() => { if (isLoaded && isSignedIn) navigate('/user-portal'); }, [isLoaded, isSignedIn, navigate]);
  const path = kind === 'sign-in' ? clerkSignInPath : clerkSignUpPath;
  return <main className="grain flex min-h-[100dvh] flex-col bg-[#f5f3eb]">
    <header className="mx-auto flex w-full max-w-[1200px] items-center justify-between px-6 py-6"><Brand /><Link href="/" className="text-sm text-[#68796d] hover:text-[#25473c]">Back to home</Link></header>
    <div className="mx-auto grid w-full max-w-[1050px] flex-1 items-center gap-10 px-5 py-8 md:grid-cols-[1fr_.85fr]">
      <section className="hidden md:block"><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#b3824e]">A careful place to study</div><h1 className="mt-5 max-w-md font-editorial text-6xl leading-[.95] tracking-[-.045em]">Your course material, in context.</h1><p className="mt-5 max-w-sm leading-7 text-[#6c7b70]">A personal library where every source and its processing status stays easy to follow.</p><div className="paper-grid mt-10 max-w-md rounded-2xl border border-[#dfdace] p-6"><div className="font-mono-ui text-[9px] uppercase tracking-widest text-[#899084]">A simple principle</div><div className="mt-3 font-editorial text-2xl">Make the source visible.</div><div className="mt-4 flex items-center gap-2 text-xs text-[#6c7b70]"><ShieldCheck size={15} /> Your materials remain yours.</div></div></section>
      <section className="mx-auto w-full max-w-[450px] rounded-[24px] border border-[#e4e0d5] bg-[#fbfaf5] p-5 shadow-[0_18px_55px_rgba(41,62,50,.07)] sm:p-8">
        <div className="mb-5"><h2 className="font-editorial text-3xl">{kind === 'sign-in' ? 'Welcome back' : 'Start your library'}</h2><p className="mt-2 text-sm text-[#728075]">{kind === 'sign-in' ? 'Sign in to return to your courses.' : 'Create an account to keep your course material together.'}</p></div>
        {kind === 'sign-in'
          ? <SignIn routing="path" path={path} signUpUrl={clerkSignUpPath} />
          : <SignUp routing="path" path={path} signInUrl={clerkSignInPath} />}
      </section>
    </div>
    <footer className="px-6 py-5 text-center font-mono-ui text-[9px] uppercase tracking-[.15em] text-[#899084]">StudyGraph · Source-linked course material</footer>
  </main>;
}

function AppFrame({ children }: { children: React.ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  const [, navigate] = useLocation();
  useEffect(() => { if (isLoaded && !isSignedIn) navigate(signInPath); }, [isLoaded, isSignedIn, navigate]);
  if (!isLoaded) return <main className="min-h-[100dvh] bg-[#f5f3eb] p-8"><div className="mx-auto max-w-5xl"><div className="skeleton h-10 w-48 rounded-xl" /><div className="skeleton mt-12 h-48 rounded-3xl" /><div className="skeleton mt-6 h-64 rounded-3xl" /></div></main>;
  if (!isSignedIn) return <main className="grid min-h-[100dvh] place-items-center text-sm text-[#718075]">Taking you to sign in…</main>;
  return <div className="grain min-h-[100dvh] bg-[#f5f3eb] text-[#25473c]">
    <header className="sticky top-0 z-30 border-b border-[#dedbd0] bg-[#f5f3eb]/95 backdrop-blur">
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-5 py-3.5 lg:px-9"><div className="flex items-center gap-8"><Brand /><div className="hidden h-6 w-px bg-[#dcd8cc] sm:block" /><span className="hidden font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#8a9286] sm:block">Study library</span></div><div className="flex items-center gap-4"><Link href="/user-portal" className="text-sm text-[#697b70] hover:text-[#25473c]">My courses</Link><UserButton appearance={{ elements: { avatarBox: 'h-9 w-9' } }} /></div></div>
    </header>
    {children}
  </div>;
}

function StatusPill({ status }: { status: SourceStatus }) {
  const map: Record<SourceStatus, { label: string; className: string; dot: string }> = {
    queued: { label: 'In queue', className: 'bg-[#f4ecd9] text-[#806b42]', dot: 'bg-[#bf9858]' },
    processing: { label: 'Processing', className: 'bg-[#e6edf0] text-[#4d6c78]', dot: 'bg-[#63889a]' },
    ready: { label: 'Ready', className: 'bg-[#e5eee4] text-[#50725a]', dot: 'bg-[#65896d]' },
    failed: { label: 'Needs attention', className: 'bg-[#f4e5e1] text-[#985f55]', dot: 'bg-[#b66d5d]' },
  };
  const item = map[status];
  return <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 font-mono-ui text-[9px] uppercase tracking-[.08em] ${item.className}`}><span className={`status-dot ${item.dot}`} />{item.label}</span>;
}

function Metric({ label, value, detail }: { label: string; value: number; detail: string }) {
  return <div className="border-l border-[#dedbd0] pl-4 first:border-0 first:pl-0"><div className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#879084]">{label}</div><div className="mt-1.5 flex items-baseline gap-2"><span className="font-editorial text-3xl leading-none">{value}</span><span className="text-[11px] text-[#828a7f]">{detail}</span></div></div>;
}

function Portal() {
  const { data: courses, isLoading, isError, refetch } = useListCourses({ request: sameOriginRequest });
  const [newCourse, setNewCourse] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [formError, setFormError] = useState('');
  const createCourse = useCreateCourse({ request: sameOriginRequest });
  const qc = useQueryClient();
  async function submitCourse(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim()) { setFormError('Give this course a name to continue.'); return; }
    setFormError('');
    try {
      await createCourse.mutateAsync({ data: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) } });
      await qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      setName(''); setDescription(''); setNewCourse(false);
    } catch { setFormError('Course could not be created. Please try again.'); }
  }
  return <AppFrame><main className="mx-auto max-w-[1280px] px-5 pb-16 pt-9 lg:px-9 lg:pt-12">
    <div className="flex flex-col justify-between gap-7 border-b border-[#dedbd0] pb-8 sm:flex-row sm:items-end">
      <div className="enter"><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#a67d4d]">Your workspace / Library</div><h1 className="mt-3 font-editorial text-5xl tracking-[-.045em] sm:text-6xl">Course library</h1><p className="mt-3 max-w-lg text-sm leading-6 text-[#718075]">A considered home for the material behind your classes.</p></div>
      <button onClick={() => setNewCourse(true)} className="inline-flex items-center justify-center gap-2.5 rounded-full bg-[#25473c] px-5 py-3 text-sm font-semibold text-[#f7f3e8] transition hover:-translate-y-0.5" data-testid="button-create-course"><Plus size={16} /> New course</button>
    </div>
    <div className="mt-8 grid grid-cols-3 gap-3 rounded-2xl border border-[#e1ddd2] bg-[#f9f7ef] p-4 sm:inline-flex sm:gap-9 sm:px-6 sm:py-4">
      <Metric label="Courses" value={courses?.length ?? 0} detail="in your library" />
      <Metric label="Sources" value={courses?.reduce((sum, c) => sum + c.sourceCount, 0) ?? 0} detail="added" />
      <Metric label="Study units" value={courses?.reduce((sum, c) => sum + c.unitCount, 0) ?? 0} detail="created" />
    </div>
    <div className="mb-4 mt-11 flex items-center justify-between"><h2 className="font-editorial text-2xl">Your courses</h2><span className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#899084]">{courses?.length ?? 0} total</span></div>
    {isLoading ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading course library">{[1, 2, 3].map(n => <div key={n} className="skeleton h-52 rounded-2xl" />)}</div>
      : isError ? <div role="alert" className="rounded-2xl border border-[#e5c7c0] bg-[#faf0ed] p-7"><div className="flex gap-3"><CircleAlert className="mt-0.5 text-[#a76357]" /><div><h3 className="font-semibold">Your library could not be loaded</h3><p className="mt-1 text-sm text-[#7d726b]">Your courses are still safe. Check your connection and try again.</p><button onClick={() => refetch()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold text-[#854f45]" data-testid="button-retry-courses"><RefreshCw size={14} /> Try again</button></div></div></div>
      : courses?.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{courses.map((course, index) => <CourseCard key={course.id} course={course} index={index} />)}</div>
      : <section className="paper-grid flex min-h-[340px] flex-col items-center justify-center rounded-[26px] border border-dashed border-[#cbc9ba] bg-[#f8f6ee] px-6 py-12 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-[#e9e8dc] text-[#547060]"><GraduationCap size={25} /></div><h3 className="mt-5 font-editorial text-3xl">Your first course starts here.</h3><p className="mt-2 max-w-sm text-sm leading-6 text-[#718075]">Create a course, then add the lecture files and recordings you want to keep in context.</p><button onClick={() => setNewCourse(true)} className="mt-6 inline-flex items-center gap-2 rounded-full bg-[#25473c] px-5 py-3 text-sm font-semibold text-[#f7f3e8]" data-testid="empty-create-course"><FolderPlus size={16} /> Create a course</button>
      </section>}
    <p className="mt-10 flex items-center gap-2 text-xs text-[#7e887d]"><ShieldCheck size={15} /> Processing states reflect what the system reports. Nothing is marked ready before it is.</p>
  </main>{newCourse && <Modal title="Create a course" onClose={() => setNewCourse(false)}>
    <p className="mb-5 text-sm leading-6 text-[#718075]">Set up a home for one class. You can add material once it is created.</p>
    <form onSubmit={submitCourse} className="space-y-4">
      <label className="block text-sm font-semibold" htmlFor="course-name">Course name <span className="text-[#9c6456]">*</span><input autoFocus id="course-name" maxLength={160} required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Introduction to ecology" className="mt-2 w-full rounded-xl border border-[#d8d5c9] bg-[#fffdf7] px-4 py-3 text-sm font-normal outline-none focus:border-[#65806c]" data-testid="input-course-name" /></label>
      <label className="block text-sm font-semibold" htmlFor="course-description">Description <span className="font-normal text-[#899084]">· optional</span><textarea id="course-description" maxLength={2000} rows={3} value={description} onChange={e => setDescription(e.target.value)} placeholder="What are you studying?" className="mt-2 w-full resize-y rounded-xl border border-[#d8d5c9] bg-[#fffdf7] px-4 py-3 text-sm font-normal outline-none focus:border-[#65806c]" data-testid="input-course-description" /></label>
      {formError && <p role="alert" className="text-sm text-[#a45e52]">{formError}</p>}
      <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setNewCourse(false)} className="rounded-full px-4 py-2.5 text-sm text-[#66766b] hover:bg-[#efede4]">Cancel</button><button disabled={createCourse.isPending} className="inline-flex items-center gap-2 rounded-full bg-[#25473c] px-5 py-2.5 text-sm font-semibold text-[#f7f3e8] disabled:opacity-60" data-testid="button-submit-course">{createCourse.isPending && <LoaderCircle size={14} className="animate-spin" />} Create course</button></div>
    </form>
  </Modal>}</AppFrame>;
}

function CourseCard({ course, index }: { course: Course; index: number }) {
  return <Link href={`/courses/${course.id}`} className="group enter flex min-h-[225px] flex-col rounded-2xl border border-[#dfdcd1] bg-[#faf9f3] p-5 transition duration-200 hover:-translate-y-1 hover:border-[#bdc9b8] hover:shadow-[0_12px_35px_rgba(41,62,50,.07)]" style={{ animationDelay: `${index * 55}ms` }} data-testid={`card-course-${course.id}`}>
    <div className="flex items-start justify-between"><span className="grid h-10 w-10 place-items-center rounded-xl bg-[#eae9df] text-[#547060]"><BookOpen size={19} /></span><ChevronRight size={18} className="mt-2 text-[#9aa095] transition-transform group-hover:translate-x-1 group-hover:text-[#547060]" /></div>
    <h3 className="mt-5 line-clamp-1 font-editorial text-[25px] tracking-[-.025em]">{course.name}</h3><p className="mt-1 line-clamp-2 min-h-10 text-sm leading-5 text-[#778176]">{course.description || 'No course description yet.'}</p>
    <div className="mt-auto flex items-center justify-between border-t border-[#e8e5dc] pt-4"><div className="flex gap-4 font-mono-ui text-[9px] uppercase tracking-[.08em] text-[#828c80]"><span>{course.sourceCount} sources</span><span>{course.unitCount} units</span></div>
      {course.processingSourceCount > 0 ? <span className="inline-flex items-center gap-1.5 text-[10px] text-[#587786]"><span className="status-dot bg-[#63889a]" />Processing</span> : course.failedSourceCount > 0 ? <span className="text-[10px] text-[#a56356]">{course.failedSourceCount} need attention</span> : <span className="text-[10px] text-[#62806a]">{course.readySourceCount} ready</span>}
    </div>
  </Link>;
}

type UploadItem = { id: string; name: string; progress: number; status: 'uploading' | 'registering' | 'queued' | 'failed'; error?: string };

function classifyFile(file: File): SourceSourceType | null {
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') return 'pdf';
  if (ext === 'pptx' || file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'mpeg', 'mpg'].includes(ext ?? '') || file.type.startsWith('video/')) return 'video';
  return null;
}

function uploadDirect(file: File, url: string, onProgress: (progress: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = event => { if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100)); };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Storage returned ${xhr.status}.`));
    xhr.onerror = () => reject(new Error('Upload connection failed. Check your connection and try again.'));
    xhr.onabort = () => reject(new Error('Upload was interrupted.'));
    xhr.send(file);
  });
}

function CourseDetail({ courseId }: { courseId: string }) {
  const { data: courses } = useListCourses({ request: sameOriginRequest });
  const course = courses?.find(item => item.id === courseId);
  const { data: sources, isLoading, isError, refetch } = useListSources({ courseId }, { query: { queryKey: getListSourcesQueryKey({ courseId }), refetchInterval: 4000 }, request: sameOriginRequest });
  const { data: summary } = useCourseSummary(courseId);
  const requestUpload = useRequestUploadUrl({ request: sameOriginRequest });
  const registerSource = useRegisterUploadedSource({ request: sameOriginRequest });
  const addYoutube = useAddYoutubeSource({ request: sameOriginRequest });
  const deleteSource = useDeleteSource({ request: sameOriginRequest });
  const qc = useQueryClient();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeTitle, setYoutubeTitle] = useState('');
  const [youtubeError, setYoutubeError] = useState('');
  const [showYoutube, setShowYoutube] = useState(false);
  const [confirmSource, setConfirmSource] = useState<Source | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const title = course?.name || 'Course sources';
  const pendingCount = sources?.filter(s => s.status === 'queued' || s.status === 'processing').length ?? 0;
  useEffect(() => {
    const timer = window.setInterval(() => {
      void qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetCourseSummaryQueryKey(courseId) });
    }, pendingCount > 0 ? 10000 : 45000);
    return () => window.clearInterval(timer);
  }, [courseId, pendingCount, qc]);
  async function updateUpload(id: string, updates: Partial<UploadItem>) { setUploads(old => old.map(item => item.id === id ? { ...item, ...updates } : item)); }
  async function handleFiles(fileList: FileList | null) {
    if (!fileList) return;
    const files = Array.from(fileList);
    for (const file of files) {
      const id = `${file.name}-${file.size}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const type = classifyFile(file);
      setUploads(old => [...old, { id, name: file.name, progress: 0, status: type ? 'uploading' : 'failed', error: type ? undefined : 'Unsupported format. Use PDF, PPTX, or a common video file.' }]);
      if (!type) continue;
      try {
        const signed = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType: file.type || 'application/octet-stream' } });
        await uploadDirect(file, signed.uploadURL, progress => { void updateUpload(id, { progress }); });
        await updateUpload(id, { status: 'registering', progress: 100 });
        await registerSource.mutateAsync({ data: {
          courseId, title: file.name.replace(/\.[^.]+$/, ''), originalFilename: file.name,
          sourceType: type, objectPath: signed.objectPath, mimeType: file.type || 'application/octet-stream',
        } });
        await updateUpload(id, { status: 'queued' });
        void qc.invalidateQueries({ queryKey: getListSourcesQueryKey({ courseId }) });
        void qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
        void qc.invalidateQueries({ queryKey: getGetCourseSummaryQueryKey(courseId) });
      } catch (error) {
        await updateUpload(id, { status: 'failed', error: error instanceof Error ? error.message : 'Upload could not be completed.' });
      }
    }
    if (fileRef.current) fileRef.current.value = '';
  }
  async function submitYoutube(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setYoutubeError('');
    try {
      const parsed = new URL(youtubeUrl.trim());
      if (!['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com'].includes(parsed.hostname)) throw new Error('Enter a valid YouTube video link.');
    } catch { setYoutubeError('Enter a valid YouTube video link.'); return; }
    try {
      await addYoutube.mutateAsync({ data: { courseId, url: youtubeUrl.trim(), ...(youtubeTitle.trim() ? { title: youtubeTitle.trim() } : {}) } });
      setYoutubeUrl(''); setYoutubeTitle(''); setShowYoutube(false);
      void qc.invalidateQueries({ queryKey: getListSourcesQueryKey({ courseId }) });
      void qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetCourseSummaryQueryKey(courseId) });
    } catch { setYoutubeError('That video could not be added. Check the link and try again.'); }
  }
  async function removeSource() {
    if (!confirmSource) return;
    setDeleteError('');
    try {
      await deleteSource.mutateAsync({ sourceId: confirmSource.id });
      setConfirmSource(null);
      void qc.invalidateQueries({ queryKey: getListSourcesQueryKey({ courseId }) });
      void qc.invalidateQueries({ queryKey: getListCoursesQueryKey() });
      void qc.invalidateQueries({ queryKey: getGetCourseSummaryQueryKey(courseId) });
    } catch { setDeleteError('This source could not be removed. Please try again.'); }
  }
  const ready = summary?.readySourceCount ?? course?.readySourceCount ?? 0;
  const count = summary?.sourceCount ?? course?.sourceCount ?? sources?.length ?? 0;
  return <AppFrame><main className="mx-auto max-w-[1280px] px-5 pb-16 pt-8 lg:px-9 lg:pt-10">
    <Link href="/user-portal" className="inline-flex items-center gap-2 text-xs text-[#788478] hover:text-[#25473c]"><ArrowLeft size={14} /> All courses</Link>
    <div className="mt-6 flex flex-col justify-between gap-6 border-b border-[#dedbd0] pb-7 sm:flex-row sm:items-end">
      <div className="enter min-w-0"><div className="font-mono-ui text-[10px] uppercase tracking-[.18em] text-[#a67d4d]">Source library / Course</div><h1 className="mt-2 truncate font-editorial text-5xl tracking-[-.045em] sm:text-6xl" data-testid="text-course-title">{title}</h1><p className="mt-3 max-w-xl text-sm leading-6 text-[#718075]">{course?.description || 'Keep lecture files and recordings together, with processing status you can follow.'}</p></div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <button onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-2 rounded-full bg-[#25473c] px-5 py-3 text-sm font-semibold text-[#f7f3e8] transition hover:-translate-y-0.5" data-testid="button-upload-file"><Upload size={15} /> Add files</button>
        <button onClick={() => setShowYoutube(true)} className="inline-flex items-center gap-2 rounded-full border border-[#d4d3c7] bg-[#f9f7ef] px-5 py-3 text-sm font-semibold text-[#365647] hover:bg-[#efede3]" data-testid="button-add-youtube"><Youtube size={16} /> YouTube</button>
        <input ref={fileRef} type="file" multiple accept={sourceAccept} className="sr-only" onChange={e => void handleFiles(e.target.files)} aria-label="Choose source files" data-testid="input-source-files" />
      </div>
    </div>
    <section aria-label="Course ingestion totals" className="mt-7 grid grid-cols-2 gap-y-5 rounded-2xl border border-[#e1ddd2] bg-[#f9f7ef] p-5 sm:flex sm:gap-0 sm:divide-x sm:divide-[#dedbd0] sm:py-5">
      <Metric label="Sources" value={count} detail="in course" /><div className="sm:pl-5"><Metric label="Study units" value={summary?.unitCount ?? course?.unitCount ?? 0} detail="created" /></div><div className="sm:pl-5"><Metric label="Ready" value={ready} detail="sources" /></div><div className="sm:pl-5"><Metric label="In progress" value={summary?.processingSourceCount ?? course?.processingSourceCount ?? 0} detail="sources" /></div>
    </section>
    <div className="mt-10 grid gap-9 lg:grid-cols-[minmax(0,1fr)_280px]">
      <section>
        <div className="mb-4 flex items-end justify-between"><div><div className="font-mono-ui text-[9px] uppercase tracking-[.16em] text-[#a67d4d]">What’s in this course</div><h2 className="mt-1 font-editorial text-3xl">Sources</h2></div><span className="font-mono-ui text-[9px] uppercase tracking-[.12em] text-[#899084]">{sources?.length ?? 0} {sources?.length === 1 ? 'source' : 'sources'}</span></div>
        <div className="overflow-hidden rounded-2xl border border-[#dfdcd1] bg-[#fbfaf5]">
          {isLoading ? <div aria-label="Loading sources">{[1, 2, 3].map(i => <div key={i} className="skeleton mx-4 my-4 h-[75px] rounded-xl" />)}</div>
            : isError ? <div role="alert" className="p-8 text-center"><CircleAlert className="mx-auto text-[#a76357]" /><h3 className="mt-3 font-semibold">Sources did not load</h3><p className="mt-1 text-sm text-[#758075]">The library is safe. Try loading it again.</p><button onClick={() => refetch()} className="mt-4 inline-flex items-center gap-2 text-sm font-semibold" data-testid="button-retry-sources"><RefreshCw size={14} /> Retry</button></div>
            : !sources?.length ? <div className="paper-grid px-6 py-14 text-center"><div className="mx-auto grid h-12 w-12 place-items-center rounded-2xl bg-[#e9e8dc] text-[#547060]"><FileText size={21} /></div><h3 className="mt-4 font-editorial text-2xl">No sources, yet.</h3><p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#718075]">Add lecture slides, a reading, or a recorded lecture. Processing begins after the source is registered.</p><button onClick={() => fileRef.current?.click()} className="mt-5 inline-flex items-center gap-2 rounded-full border border-[#bdc9b8] px-4 py-2.5 text-sm font-semibold text-[#385847] hover:bg-[#edf0e7]" data-testid="empty-upload-source"><Plus size={14} /> Add the first file</button></div>
            : <div>{sources.map((source, index) => <SourceRow key={source.id} source={source} index={index} onRemove={() => setConfirmSource(source)} />)}</div>}
        </div>
        {uploads.length > 0 && <section className="mt-5 rounded-2xl border border-[#dfdcd1] bg-[#fbfaf5] p-4" aria-live="polite"><div className="mb-3 flex items-center justify-between"><h3 className="font-semibold text-sm">Recent uploads</h3><button className="text-xs text-[#7b8579] hover:text-[#25473c]" onClick={() => setUploads([])}>Dismiss</button></div><div className="space-y-3">{uploads.map(item => <div key={item.id} className="rounded-xl bg-[#f2f0e8] px-3 py-2.5" data-testid={`upload-item-${item.id}`}><div className="flex items-center justify-between gap-3"><span className="min-w-0 truncate text-xs font-medium">{item.name}</span><span className="shrink-0 font-mono-ui text-[9px] uppercase tracking-wider text-[#69796e]">{item.status === 'uploading' ? `${item.progress}% uploaded` : item.status === 'registering' ? 'Registering' : item.status === 'queued' ? 'Queued for processing' : 'Upload failed'}</span></div>{item.status === 'uploading' && <div className="mt-2 h-1 overflow-hidden rounded-full bg-[#dddcd1]"><div className="h-full rounded-full bg-[#67836f] transition-[width] duration-200" style={{ width: `${item.progress}%` }} /></div>}{item.error && <p role="alert" className="mt-1 text-xs text-[#a45e52]">{item.error}</p>}</div>)}</div></section>}
      </section>
      <aside className="space-y-4">
        <div className="rounded-2xl border border-[#dedbd0] bg-[#eeece2] p-5"><div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.15em] text-[#65796a]"><Clock3 size={14} /> Processing guide</div><h3 className="mt-3 font-editorial text-2xl">Status, without guesswork.</h3><p className="mt-2 text-xs leading-5 text-[#748075]">Each source reports its current state. Queued sources are waiting; processing sources are being worked on; ready sources have finished.</p><div className="mt-4 flex flex-wrap gap-2"><StatusPill status="queued" /><StatusPill status="processing" /><StatusPill status="ready" /></div></div>
        <div className="rounded-2xl border border-[#dedbd0] bg-[#faf9f3] p-5"><div className="flex items-center gap-2 font-mono-ui text-[9px] uppercase tracking-[.15em] text-[#a67d4d]"><ShieldCheck size={14} /> Source first</div><p className="mt-3 text-sm leading-6 text-[#6d7c71]">StudyGraph keeps your materials attached to their original source, so the context stays close.</p></div>
      </aside>
    </div>
    {showYoutube && <Modal title="Add a YouTube source" onClose={() => { setShowYoutube(false); setYoutubeError(''); }}>
      <p className="mb-5 text-sm leading-6 text-[#718075]">Add a lecture by its public YouTube link. The video is queued for processing after you submit.</p>
      <form onSubmit={submitYoutube} className="space-y-4">
        <label htmlFor="youtube-url" className="block text-sm font-semibold">YouTube URL<input id="youtube-url" required type="url" value={youtubeUrl} onChange={e => setYoutubeUrl(e.target.value)} placeholder="https://www.youtube.com/watch?v=…" className="mt-2 w-full rounded-xl border border-[#d8d5c9] bg-[#fffdf7] px-4 py-3 text-sm font-normal outline-none focus:border-[#65806c]" data-testid="input-youtube-url" /></label>
        <label htmlFor="youtube-title" className="block text-sm font-semibold">Title <span className="font-normal text-[#899084]">· optional</span><input id="youtube-title" maxLength={300} value={youtubeTitle} onChange={e => setYoutubeTitle(e.target.value)} placeholder="e.g. Lecture 6 — neural signaling" className="mt-2 w-full rounded-xl border border-[#d8d5c9] bg-[#fffdf7] px-4 py-3 text-sm font-normal outline-none focus:border-[#65806c]" data-testid="input-youtube-title" /></label>
        {youtubeError && <p role="alert" className="text-sm text-[#a45e52]">{youtubeError}</p>}
        <div className="flex justify-end gap-2 pt-2"><button type="button" onClick={() => setShowYoutube(false)} className="rounded-full px-4 py-2.5 text-sm text-[#66766b] hover:bg-[#efede4]">Cancel</button><button disabled={addYoutube.isPending} className="inline-flex items-center gap-2 rounded-full bg-[#25473c] px-5 py-2.5 text-sm font-semibold text-[#f7f3e8] disabled:opacity-60" data-testid="button-submit-youtube">{addYoutube.isPending && <LoaderCircle size={14} className="animate-spin" />} Add source</button></div>
      </form>
    </Modal>}
    {confirmSource && <Modal title="Remove this source?" onClose={() => { if (!deleteSource.isPending) { setConfirmSource(null); setDeleteError(''); } }}>
      <p className="mb-3 text-sm leading-6 text-[#718075]">“{confirmSource.title}” and its extracted study material will be removed from this course. This cannot be undone.</p>
      {deleteError && <p role="alert" className="mb-3 text-sm text-[#a45e52]">{deleteError}</p>}
      <div className="flex justify-end gap-2 pt-2"><button disabled={deleteSource.isPending} onClick={() => setConfirmSource(null)} className="rounded-full px-4 py-2.5 text-sm text-[#66766b] hover:bg-[#efede4]">Keep source</button><button disabled={deleteSource.isPending} onClick={() => void removeSource()} className="inline-flex items-center gap-2 rounded-full bg-[#a45e52] px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60" data-testid="button-confirm-delete">{deleteSource.isPending && <LoaderCircle size={14} className="animate-spin" />} Remove source</button></div>
    </Modal>}
  </main></AppFrame>;
}

function SourceRow({ source: listedSource, index, onRemove }: { source: Source; index: number; onRemove: () => void }) {
  // Source has no ingestion-job ID, so poll its authoritative source-status endpoint while active.
  const { data: currentSource } = useGetSource(listedSource.id, {
    query: {
      queryKey: getGetSourceQueryKey(listedSource.id),
      enabled: listedSource.status === 'queued' || listedSource.status === 'processing',
      refetchInterval: listedSource.status === 'queued' || listedSource.status === 'processing' ? 3500 : false,
    }, request: sameOriginRequest,
  });
  const source = currentSource ?? listedSource;
  const Icon = source.sourceType === 'video' ? Film : FileText;
  const created = new Date(source.createdAt);
  const date = Number.isNaN(created.getTime()) ? 'Date unavailable' : created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return <article className={`group flex flex-col gap-3 border-b border-[#e8e5dc] p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-5 ${index === 0 ? 'enter' : ''}`} data-testid={`source-row-${source.id}`}>
    <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${source.sourceType === 'video' ? 'bg-[#eee5e3] text-[#a76d62]' : source.sourceType === 'pptx' ? 'bg-[#f2e9dd] text-[#a77947]' : 'bg-[#e8ebdf] text-[#5c7963]'}`}><Icon size={18} /></div>
    <div className="min-w-0 flex-1"><div className="flex min-w-0 flex-wrap items-center gap-2"><h3 className="max-w-full truncate text-sm font-semibold">{source.title}</h3><StatusPill status={source.status} /></div><p className="mt-1 truncate text-xs text-[#828a7f]">{source.originalFilename || source.sourceUrl || source.sourceType.toUpperCase()} <span className="px-1 text-[#bab9ae]">·</span> Added {date}</p>
      {(source.status === 'queued' || source.status === 'processing') && <div className="mt-2 max-w-[360px]"><div className="flex justify-between text-[10px] text-[#78847a]"><span>{source.currentStep || (source.status === 'queued' ? 'Waiting to start' : 'Working through source')}</span><span>{Math.max(0, Math.min(100, source.progress))}%</span></div><div className="mt-1 h-1 overflow-hidden rounded-full bg-[#e5e3d9]"><div className="h-full rounded-full bg-[#698a76] transition-[width] duration-500" style={{ width: `${Math.max(0, Math.min(100, source.progress))}%` }} /></div></div>}
      {source.status === 'failed' && <p role="alert" className="mt-1 flex items-center gap-1 text-xs text-[#a45e52]"><CircleAlert size={12} />{source.error || 'Processing failed. The source has not been marked ready.'}</p>}
      {source.status === 'ready' && <p className="mt-1 text-[10px] text-[#718075]">{source.unitsCreated} {source.unitsCreated === 1 ? 'study unit' : 'study units'} created</p>}
    </div>
    <button onClick={onRemove} aria-label={`Remove ${source.title}`} className="self-end rounded-full p-2 text-[#9a9d91] opacity-100 transition hover:bg-[#f4e5e1] hover:text-[#a45e52] sm:self-center sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" data-testid={`button-remove-source-${source.id}`}><Trash2 size={15} /></button>
  </article>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    function onKey(event: KeyboardEvent) { if (event.key === 'Escape') closeRef.current(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#20362e]/40 p-0 backdrop-blur-[2px] sm:items-center sm:p-5" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section role="dialog" aria-modal="true" aria-labelledby="dialog-title" className="max-h-[92dvh] w-full overflow-y-auto rounded-t-[24px] border border-[#dedbd0] bg-[#fbfaf5] p-5 shadow-[0_25px_80px_rgba(20,42,33,.2)] sm:max-w-[480px] sm:rounded-[24px] sm:p-7">
      <div className="flex items-start justify-between gap-4"><h2 id="dialog-title" className="font-editorial text-3xl">{title}</h2><button onClick={onClose} aria-label="Close dialog" className="rounded-full p-2 text-[#718075] hover:bg-[#efede4]"><X size={18} /></button></div>
      <div className="mt-4">{children}</div>
    </section>
  </div>;
}

function useCourseSummary(courseId: string) {
  return useGetCourseSummary(courseId, { query: { queryKey: getGetCourseSummaryQueryKey(courseId), refetchInterval: 12_000 }, request: sameOriginRequest });
}

function Routes() {
  const [path] = useLocation();
  return <ErrorBoundary resetKey={path}><Switch>
    <Route path="/"><Landing /></Route>
    <Route path="/sign-in"><AuthPages kind="sign-in" /></Route>
    <Route path="/sign-in/:rest*"><AuthPages kind="sign-in" /></Route>
    <Route path="/sign-up"><AuthPages kind="sign-up" /></Route>
    <Route path="/sign-up/:rest*"><AuthPages kind="sign-up" /></Route>
    <Route path="/user-portal"><Portal /></Route>
    <Route path="/courses/:courseId">{params => <CourseDetail courseId={params.courseId} />}</Route>
    <Route component={NotFound} />
  </Switch></ErrorBoundary>;
}

function Application() {
  return <WouterRouter base={BASE}><Routes /></WouterRouter>;
}

function App() {
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
  return <QueryClientProvider client={queryClient}>
    {publishableKey
      ? <ClerkProvider publishableKey={publishableKey} signInUrl={clerkSignInPath} signUpUrl={clerkSignUpPath} afterSignOutUrl={BASE || '/'}>
          <Application />
        </ClerkProvider>
      : <main className="grid min-h-[100dvh] place-items-center bg-[#f5f3eb] px-6 text-[#25473c]"><div className="max-w-lg text-center"><Brand /><h1 className="mt-8 font-editorial text-4xl">StudyGraph needs its sign-in configuration.</h1><p className="mt-3 text-sm leading-6 text-[#718075]">Set the Clerk publishable key as <code className="rounded bg-[#e9e6dc] px-1.5 py-1">VITE_CLERK_PUBLISHABLE_KEY</code> to enable accounts and the course library.</p></div></main>}
  </QueryClientProvider>;
}

export default App;
