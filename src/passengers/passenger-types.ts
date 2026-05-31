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
  | 'full_name_exact'
  | 'token_match'
  | 'unique_given_name'
  | 'fuzzy_match'
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
  dateOfBirth?: string | null;
  documentType?: string | null;
  documentNumber?: string | null;
  documentExpiryDate?: string | null;
  documentCountry?: string | null;
  email?: string | null;
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
  email: string | null;
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
      status: 'matched';
      profile: PassengerProfile;
      confidenceScore: number;
      reason: ConfidenceReason;
      missingFields: [];
    }
  | {
      status: 'matched_but_missing_fields';
      profile: PassengerProfile;
      confidenceScore: number;
      reason: 'missing_required_field';
      missingFields: string[];
    }
  | {
      status: 'ambiguous';
      confidenceScore: number;
      reason: 'ambiguous_candidate';
      candidates: PassengerProfile[];
      missingFields: [];
    }
  | {
      status: 'not_found';
      confidenceScore: 0;
      reason: 'no_match';
      candidates: [];
      missingFields: [];
    };
