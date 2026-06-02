export type Vacancy = {
  id: string;
  role: string;
  location: string;
  duration: string;
  description: string;
  postedAt: string;
};

export type CreateVacancyInput = Omit<Vacancy, 'id'>;
