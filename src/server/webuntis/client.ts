import { z } from 'zod';
import { enrichTimetableExamDetails } from './timetable-exam-details.js';
import { enrichTimetableClasses } from './timetable-classes.js';
import type {
  AccountInput,
  Capability,
  CapabilityStatus,
} from '../../shared/types.js';
import { AppError } from '../errors.js';
import {
  secureTransport,
  serverOrigin,
  responseText,
  type Transport,
} from './http.js';
import {
  examsSchema,
  holidaySchema,
  loginSchema,
  rpcEnvelope,
  rpcTimetableSchema,
  rpcYearsSchema,
  schoolYearsSchema,
  timetableSchema,
  calendarEntryDetailsSchema,
} from './schemas.js';

const MAX_REST_TOKEN_LENGTH = 16384;

export class WebUntisError extends AppError {
  constructor(
    public status: CapabilityStatus,
    public reason?: Capability['reason'],
  ) {
    super(`WEBUNTIS_${(reason ?? status).toUpperCase()}`, 502);
  }
}
export class WebUntisClient {
  private cookies = new Map<string, string>();
  private token = '';
  private personId = 0;
  private tenantId = '';
  private schoolYearId = '';
  private origin: string;
  private receivedResponse = false;
  private classLookupUnavailable = false;
  constructor(
    private credentials: AccountInput & { password: string },
    private transport: Transport = secureTransport(),
  ) {
    this.origin = serverOrigin(credentials.server);
  }
  close() {
    return this.transport.close();
  }
  serverReached() {
    return this.receivedResponse;
  }
  private async request(
    path: string,
    body?: object,
    bearer = false,
  ): Promise<string> {
    const headers = new Headers({
      accept: 'application/json',
      cookie: [...this.cookies]
        .map(([name, value]) => `${name}=${value}`)
        .join('; '),
    });
    if (body) headers.set('content-type', 'application/json');
    if (bearer && this.token)
      headers.set('authorization', `Bearer ${this.token}`);
    if (this.tenantId) headers.set('Tenant-Id', this.tenantId);
    if (this.schoolYearId)
      headers.set('X-Webuntis-Api-School-Year-Id', this.schoolYearId);
    let response: Response;
    try {
      response = await this.transport.fetch(new URL(path, this.origin), {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new WebUntisError('server');
    }
    this.receivedResponse = true;
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';')[0];
      const separator = pair.indexOf('=');
      if (separator > 0)
        this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new WebUntisError('authentication');
      if (response.status === 403) throw new WebUntisError('forbidden');
      if (response.status === 404 || response.status === 405)
        throw new WebUntisError('unavailable');
      throw new WebUntisError('server');
    }
    return responseText(response);
  }
  private parseJson(text: string): unknown {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new WebUntisError('invalid');
    }
  }
  async rpc(method: string, params: object = {}): Promise<unknown> {
    try {
      return await this.rpcOnce(method, params);
    } catch (error) {
      if (
        method !== 'authenticate' &&
        error instanceof WebUntisError &&
        error.status === 'authentication'
      ) {
        await this.login();
        return this.rpcOnce(method, params);
      }
      throw error;
    }
  }
  private async rpcOnce(method: string, params: object): Promise<unknown> {
    const raw = await this.request(
      `/WebUntis/jsonrpc.do?school=${encodeURIComponent(this.credentials.school)}`,
      { id: 'bridge', jsonrpc: '2.0', method, params },
    );
    const parsed = rpcEnvelope.safeParse(this.parseJson(raw));
    if (!parsed.success) throw new WebUntisError('invalid');
    if (parsed.data.error) {
      const code = parsed.data.error.code;
      // WebUntis uses -8504 for bad credentials, not missing permissions.
      if (code === -8504)
        throw new WebUntisError('authentication', 'invalid_credentials');
      if (code === -8500) throw new WebUntisError('invalid', 'invalid_school');
      if (code === -8509) throw new WebUntisError('forbidden');
      if (code === -32601) throw new WebUntisError('unavailable');
      if ([-8502, -8520].includes(code))
        throw new WebUntisError('authentication');
      throw new WebUntisError('server');
    }
    return parsed.data.result;
  }
  async login() {
    this.cookies.clear();
    this.token = '';
    this.tenantId = '';
    const login = loginSchema.parse(
      await this.rpc('authenticate', {
        user: this.credentials.username,
        password: this.credentials.password,
        client: 'WebUntis ICS Bridge',
      }),
    );
    if (login.personType !== 5)
      throw new WebUntisError('forbidden', 'unsupported_account');
    this.personId = login.personId;
    this.cookies.set('JSESSIONID', login.sessionId);
    this.cookies.set(
      'schoolname',
      encodeURIComponent(
        `_${Buffer.from(this.credentials.school).toString('base64')}`,
      ),
    );
  }
  private async acquireToken() {
    const token = (await this.request('/WebUntis/api/token/new')).trim();
    const parts = token.split('.');
    if (
      token.length > MAX_REST_TOKEN_LENGTH ||
      parts.length !== 3 ||
      parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
    )
      throw new WebUntisError('invalid');
    // Read only the routing claim from the selected HTTPS server's token.
    // It never authenticates local users or controls the destination URL.
    const claims = z
      .object({
        tenant_id: z.union([
          z.string().regex(/^\d{1,20}$/),
          z.number().int().nonnegative(),
        ]),
      })
      .safeParse(
        this.parseJson(Buffer.from(parts[1], 'base64url').toString('utf8')),
      );
    if (!claims.success) throw new WebUntisError('invalid');
    this.tenantId = String(claims.data.tenant_id);
    this.token = token;
  }
  async rest(path: string, retry = true): Promise<unknown> {
    try {
      if (!this.token) await this.acquireToken();
      return this.parseJson(await this.request(path, undefined, true));
    } catch (error) {
      if (
        retry &&
        error instanceof WebUntisError &&
        error.status === 'authentication'
      ) {
        await this.login();
        return this.rest(path, false);
      }
      if (retry && error instanceof WebUntisError && error.status === 'server')
        return this.rest(path, false);
      throw error;
    }
  }
  async years() {
    try {
      return schoolYearsSchema.parse(
        await this.rest('/WebUntis/api/rest/view/v1/schoolyears'),
      );
    } catch (error) {
      if (
        !(error instanceof WebUntisError) ||
        !['unavailable', 'forbidden'].includes(error.status)
      )
        throw error;
      return rpcYearsSchema
        .parse(await this.rpc('getSchoolyears'))
        .map((year) => ({
          id: year.id,
          name: year.name,
          dateRange: {
            start: String(year.startDate),
            end: String(year.endDate),
          },
        }));
    }
  }
  async timetable(start: string, end: string, yearId?: string) {
    if (yearId) this.schoolYearId = yearId;
    const query = new URLSearchParams({
      start,
      end,
      format: '1',
      layout: 'START_TIME',
      periodTypes: '',
      resourceType: 'STUDENT',
      resources: String(this.personId),
      timetableType: 'MY_TIMETABLE',
    });
    const timetable = timetableSchema.parse(
      await this.rest(`/WebUntis/api/rest/view/v1/timetable/entries?${query}`),
    );
    const withClasses = await enrichTimetableClasses(
      timetable,
      this.credentials.timezone,
      async () => {
        if (this.classLookupUnavailable) return [];
        try {
          return await this.rpcTimetable(start, end);
        } catch (error) {
          if (
            !(error instanceof WebUntisError) ||
            !['forbidden', 'unavailable'].includes(error.status)
          )
            throw error;
          this.classLookupUnavailable = true;
          return [];
        }
      },
    );
    return enrichTimetableExamDetails(
      withClasses,
      this.credentials.timezone,
      async (startDateTime, endDateTime) => {
        const detailsQuery = new URLSearchParams({
          elementId: String(this.personId),
          elementType: '5',
          startDateTime,
          endDateTime,
        });
        return calendarEntryDetailsSchema.parse(
          await this.rest(
            `/WebUntis/api/rest/view/v2/calendar-entry/detail?${detailsQuery}`,
          ),
        );
      },
    );
  }
  async rpcTimetable(start: string, end: string) {
    return rpcTimetableSchema.parse(
      await this.rpc('getTimetable', {
        options: {
          element: { id: this.personId, type: 5 },
          startDate: Number(start.replaceAll('-', '')),
          endDate: Number(end.replaceAll('-', '')),
          showInfo: true,
          showSubstText: true,
          showLsText: true,
          showStudentgroup: true,
          klasseFields: ['id', 'name', 'longname'],
          teacherFields: ['id', 'name', 'longname'],
          roomFields: ['id', 'name', 'longname'],
          subjectFields: ['id', 'name', 'longname'],
        },
      }),
    );
  }
  async exams(start: string, end: string) {
    const query = new URLSearchParams({
      startDate: start.replaceAll('-', ''),
      endDate: end.replaceAll('-', ''),
      klasseId: '-1',
      withGrades: 'false',
    });
    const response = examsSchema.parse(
      await this.rest(`/WebUntis/api/exams?${query}`),
    );
    return response.data.exams.filter(
      (exam) =>
        !exam.assignedStudents ||
        exam.assignedStudents.some(
          (student) => String(student.id) === String(this.personId),
        ),
    );
  }
  async holidays() {
    return z.array(holidaySchema).parse(await this.rpc('getHolidays'));
  }
}
