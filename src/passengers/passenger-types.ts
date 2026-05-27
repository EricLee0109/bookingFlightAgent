export type PassengerSource =
  | 'onebooking_suggest'
  | 'operator_input'
  | 'onebooking_form_hydrated'
  | 'successful_hold';

export type PassengerAliasType =
  | 'full_name'
  | 'first_name'
  | 'given_name'
  | 'last_name';

export type ConfidenceReason =
  | 'exact_alias'
  | 'unique_given_name'
  | 'ambiguous_candidate'
  | 'missing_required_field'
  | 'no_match';

export type OneBookingPassengerSuggestItem = {
  type: number;
  lastName: string;
  firstName: string;
  title: string;
  gender: boolean;
};

export type PassengerProfileInput = {
  passengerType: number;
  lastName: string;
  firstName: string;
  title: string;
  gender: boolean | null;
  source: PassengerSource;
  rawSourceJson?: string | null;
};

export type PassengerProfile = PassengerProfileInput & {
  id: number;
  normalizedLastName: string;
  normalizedFirstName: string;
  normalizedFullName: string;
  dateOfBirth: string | null;
  documentType: string | null;
  documentNumber: string | null;
  documentExpiryDate: string | null;
  documentCountry: string | null;
  seenCount: number;
  createdAt: string;
  updatedAt: string;
};

export type PassengerAliasInput = {
  passengerProfileId: number;
  aliasText: string;
  normalizedAlias: string;
  aliasType: PassengerAliasType;
};

export type ConfidenceScoreInput = {
  passengerProfileId: number;
  score: number;
  reason: ConfidenceReason;
  source: PassengerSource;
  observedQuery: string;
};

export type PassengerResolveResult =
  | {
      ok: true;
      profile: PassengerProfile;
      confidenceScore: number;
      reason: ConfidenceReason;
    }
  | {
      ok: false;
      confidenceScore: number;
      reason: ConfidenceReason;
      candidates: PassengerProfile[];
    };
