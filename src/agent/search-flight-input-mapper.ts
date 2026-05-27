import { type SearchFlightsInput } from '../automation/1booking/flight-search';
import {
  validateAutomationSupport,
  validateSearchFlightInput,
  type ParsedFlightRequest,
} from '../contracts/flight';
import {
  resolveAirportByCode,
  resolveAirportFromText,
  type ResolvedAirport,
} from './airport-resolver';

/**
 * Agent boundary for converting validated parser output into automation input.
 *
 * This component is intentionally separate from the OpenAI parser and
 * Playwright flow. It is the final safety gate that normalizes airports,
 * validates required fields, blocks unsupported trip types, and returns only
 * the exact shape accepted by 1Booking search automation.
 */

/**
 * Converts a parsed flight request into the exact input shape required by
 * the 1Booking Playwright search flow.
 *
 * Why this exists:
 * - If required fields are missing, it throws a clear error before automation starts.
 * - We should never pass raw AI output directly into Browser Automation.
 * - This mapper acts as a safety boundary between Agent logic and Playwright.
 */
export function mapParsedRequestToSearchFlightsInput(
  parsed: ParsedFlightRequest,
): SearchFlightsInput {
  const automationSupport = validateAutomationSupport(parsed);

  if (!automationSupport.supported) {
    throw new Error(
      automationSupport.reason ??
        'Cannot map parsed request to SearchFlightsInput. Unsupported automation flow.',
    );
  }

  const normalizedParsed = normalizeParsedAirportFieldsForSearch(parsed);
  const validation = validateSearchFlightInput(normalizedParsed);

  if (!validation.valid) {
    throw new Error(
      `Cannot map parsed request to SearchFlightsInput. Missing fields: ${validation.missingFields.join(
        ', ',
      )}`,
    );
  }

  const {
    fromAirportCode,
    fromAirportText,
    toAirportCode,
    toAirportText,
    departureDate,
  } = normalizedParsed;

  if (
    !fromAirportCode ||
    !fromAirportText ||
    !toAirportCode ||
    !toAirportText ||
    !departureDate
  ) {
    throw new Error(
      'Cannot map parsed request to SearchFlightsInput. Parsed request is incomplete.',
    );
  }

  const fromAirport = resolveAirportByCode(fromAirportCode);
  const toAirport = resolveAirportByCode(toAirportCode);

  if (!fromAirport || !toAirport) {
    throw new Error(
      `Cannot map parsed request to SearchFlightsInput. Unsupported airport code(s): ${[
        !fromAirport ? fromAirportCode : null,
        !toAirport ? toAirportCode : null,
      ]
        .filter(Boolean)
        .join(', ')}`,
    );
  }

  return {
    fromAirportCode: fromAirport.code,
    fromAirportText: fromAirport.text,
    toAirportCode: toAirport.code,
    toAirportText: toAirport.text,
    departureDate,
  };
}

/**
 * Completes airport code/text from the local catalog before validation.
 *
 * OpenAI should return airport codes, but this fallback lets the mapper recover
 * when the model returns a recognizable airport text such as "cam ranh" without
 * `CXR`. Raw AI output still never reaches Playwright.
 */
export function normalizeParsedAirportFieldsForSearch(
  parsed: ParsedFlightRequest,
): ParsedFlightRequest {
  const fromAirport: ResolvedAirport | null =
    resolveAirportByNullableCode(parsed.fromAirportCode) ??
    resolveAirportByNullableText(parsed.fromAirportText);
  const toAirport: ResolvedAirport | null =
    resolveAirportByNullableCode(parsed.toAirportCode) ??
    resolveAirportByNullableText(parsed.toAirportText);
  const resolvedFields = new Set<string>();

  if (fromAirport) {
    resolvedFields.add('fromAirportCode');
    resolvedFields.add('fromAirportText');
  }

  if (toAirport) {
    resolvedFields.add('toAirportCode');
    resolvedFields.add('toAirportText');
  }

  return {
    ...parsed,
    fromAirportCode: fromAirport?.code ?? parsed.fromAirportCode,
    fromAirportText: fromAirport?.text ?? parsed.fromAirportText,
    toAirportCode: toAirport?.code ?? parsed.toAirportCode,
    toAirportText: toAirport?.text ?? parsed.toAirportText,
    missingFields: parsed.missingFields.filter(
      (field) => !resolvedFields.has(field),
    ),
  };
}

/**
 * Resolves a nullable airport code without leaking string unions into callers.
 */
function resolveAirportByNullableCode(code: string | null) {
  return code ? resolveAirportByCode(code) : null;
}

/**
 * Resolves nullable airport text without leaking string unions into callers.
 */
function resolveAirportByNullableText(text: string | null) {
  return text ? resolveAirportFromText(text) : null;
}
