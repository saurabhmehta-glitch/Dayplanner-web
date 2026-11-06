export type TripType = 'Solo' | 'Couple' | 'Friends' | 'Family' | 'Group';
export type Pace = 'Relaxed' | 'Balanced' | 'Packed';
export type Transport = 'Personal car' | 'Bike' | 'Public transport' | 'Bus' | 'Train' | 'Taxi or cab' | 'Walking' | 'Other';
export type BudgetBasis = 'group' | 'person';

export interface Preferences {
  start: string; destination: string; date: string; adults: number; children: number; travelers: number; tripType: TripType;
  depart: string; return: string; pace: Pace; budget: number; budgetBasis: BudgetBasis; budgetType: 'Budget-friendly' | 'Moderate' | 'Premium';
  spending: string[]; interests: string[]; transport: Transport[]; maxDistance: number; multiMode: boolean;
  dietary: string; restaurantRecommendations: boolean; accessibility: string; childrenElderly: boolean; crowd: 'Popular' | 'Less crowded';
  mustVisit: string; avoid: string; indoorOutdoor: 'Any' | 'Mostly indoor' | 'Mostly outdoor'; scenicRoutes: boolean;
  weatherFlexible: boolean; extra: string;
}

export interface SourceReference { title: string; url: string; publishedAt?: string; }
export interface DestinationRecommendation { name: string; reason: string; distanceKm?: number; coordinatesVerified: boolean; lat?: number; lon?: number; sources: SourceReference[]; }
export interface Stop {
  id: string; name: string; category: string; arrival: string; departure: string; description: string;
  match: string; duration: number; distanceFromPreviousKm: number | null; travelMinutes: number | null;
  entryCostPerPerson: number | null; activityCostPerPerson: number | null; priceStatus: 'estimated' | 'unavailable';
  lat?: number; lon?: number; coordinatesVerified?: boolean; routeVerified?: boolean;
}
export interface BudgetBreakdown { transportation: number; food: number; tickets: number; activities: number; parking: number; miscellaneous: number; }
export interface Itinerary {
  id: string; title: string; destination: string; start: string; date: string; travelers: number; adults: number; children: number;
  currency: 'INR'; budgetBasis: BudgetBasis; budgetLimit: number; remainingBudget: number;
  totalDistanceKm: number | null; routeVerified: boolean; routeGeometry?: [number, number][]; totalDurationHours: number; totalPerPerson: number; totalGroup: number;
  remainingBudgetPerPerson: number; stops: Stop[]; budget: BudgetBreakdown;
  recommendations: DestinationRecommendation[]; researchSources: SourceReference[]; tips: string[]; source: 'demo' | 'ai'; generatedAt: string;
}
export interface SavedTrip { id: string; savedAt: string; preferences: Preferences; itinerary: Itinerary }

export interface WeatherCurrent { temperatureC: number; feelsLikeC: number; humidityPercent: number; windSpeedKph: number; condition: string; description: string; observedAt: string; }
export interface WeatherForecast { date: string; minTemperatureC: number; maxTemperatureC: number; condition: string; description: string; precipitationChancePercent: number; }
export interface WeatherSnapshot { location: string; current: WeatherCurrent; forecast: WeatherForecast | null; forecastStatus: 'available' | 'outside-range' | 'unavailable'; source: 'OpenWeather'; }
export interface Place { name: string; category: string; lat: number; lon: number; source: 'OpenStreetMap'; }
export interface RouteLeg { distanceKm: number; durationMinutes: number; geometry: { type: 'LineString'; coordinates: [number, number][] }; source: 'OSRM'; verified: true; }
