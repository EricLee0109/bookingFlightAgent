import { type ParsedFlightRequest } from './flight-request-schema';
import { type FlightRequestParser } from './flight-request-parser';

/**
 * Temporary mock parser for Telegram Agent MVP v0.
 *
 * Responsibilities:
 * - Return a fixed valid route for testing Telegram -> Playwright -> Telegram.
 * - Avoid debugging AI output too early.
 * - Help verify that the Telegram Bot can trigger 1Booking automation
 *   and send the screenshot back successfully.
 *
 * TODO:
 * Replace this function with the real AI parser using Structured Outputs.
 */
export async function mockParseFlightRequest(
  rawMessage: string,
): Promise<ParsedFlightRequest> {
  console.log('Mock parsing Telegram request:', rawMessage);

  return {
    fromAirportCode: 'HAN',
    fromAirportText: 'Sân bay Nội Bài (HAN)',

    toAirportCode: 'SGN',
    toAirportText: 'Sân bay Tân Sơn Nhất (SGN)',

    departureDate: '2026-05-13',
    returnDate: null,

    preferredTime: 'morning',
    specificTime: null,

    tripType: 'one_way',

    missingFields: [],
  };
}

/**
 * Parser object for callers that prefer dependency injection over direct
 * function imports.
 */
export const mockFlightRequestParser: FlightRequestParser = {
  parse: mockParseFlightRequest,
};
