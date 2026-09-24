export interface BmcTarget {
  host: string;
  port: number;
  scheme: 'http' | 'https';
}
