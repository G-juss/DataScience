import { Injectable } from '@angular/core';
import { Auth } from '@angular/fire/auth';
import {
  Firestore,
  collection,
  getDocs,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
} from '@angular/fire/firestore';

// ─────────────────────────────────────────────────────────
// Tipos de salida
// ─────────────────────────────────────────────────────────

export type RiskLevel = 'Alto' | 'Medio' | 'Bajo';

export interface ExamDifficultyResult {
  examId: string;
  examName: string;
  topic: string;
  difficulty: 'basico' | 'intermedio' | 'avanzado';
  difficultyIndex: number;     // promedio de score/totalPoints (0 a 1)
  difficultyLabel: 'Fácil' | 'Moderado' | 'Difícil';
  totalAttempts: number;
}

export interface EarlyAlert {
  uid: string;
  displayName: string;
  email: string;
  riskScore: number;           // 0–100
  riskLevel: RiskLevel;
  detail: {
    avgExamScore: number;      // 0–1, promedio de sus exámenes
    daysSinceLastActivity: number;
    totalGuides: number;
    totalExamsCompleted: number;
    weeklyStudyMinutes: number;
  };
}

export interface DashboardAlertRow {
  student: string;
  career: string;
  subject: string;
  risk: RiskLevel;
  score: string;               // Ej: "82%"
}

export interface AlertDashboardData {
  alerts: DashboardAlertRow[];
  kpis: {
    totalStudents: number;
    highRiskCount: number;
    activeSubjects: number;
    avgActivityPercent: number;
  };
  difficultyDistribution: {
    facil: number;
    moderado: number;
    dificil: number;
  };
  recommendations: string[];
}

// ─────────────────────────────────────────────────────────
// Pesos del modelo de riesgo (ajustables)
// ─────────────────────────────────────────────────────────

const RISK_WEIGHTS = {
  examScore: 0.40,         // 40% — promedio de notas
  inactivity: 0.30,        // 30% — días sin actividad
  guides: 0.30,            // 30% — guías generadas
};

const INACTIVITY_MAX_DAYS = 14;  // más de esto → máximo riesgo por inactividad
const GUIDES_TARGET = 3;         // número de guías que marca "activo"

@Injectable({ providedIn: 'root' })
export class EarlyAlertService {

  constructor(
    private firestore: Firestore,
    private auth: Auth,
  ) {}

  // ─────────────────────────────────────────────────────
  // 1. Dificultad de exámenes del usuario actual
  // ─────────────────────────────────────────────────────

  async getMyExamDifficulty(): Promise<ExamDifficultyResult[]> {
    const uid = this.auth.currentUser?.uid;
    if (!uid) return [];

    const snap = await getDocs(
      query(collection(this.firestore, 'exams'), where('uid', '==', uid))
    );

    const results: ExamDifficultyResult[] = [];

    for (const doc of snap.docs) {
      const data = doc.data();

      // Solo exámenes con al menos un intento completado
      const results_data = data['results'];
      if (!results_data?.completed) continue;

      const score = Number(results_data.score ?? 0);
      const total = Number(results_data.totalPoints ?? 1);
      const difficultyIndex = total > 0 ? score / total : 0;

      results.push({
        examId: doc.id,
        examName: String(data['name'] ?? ''),
        topic: String(data['topic'] ?? ''),
        difficulty: data['difficulty'] ?? 'intermedio',
        difficultyIndex,
        difficultyLabel: this.toDifficultyLabel(difficultyIndex),
        totalAttempts: Number(data['completedAttempts'] ?? 1),
      });
    }

    return results.sort((a, b) => a.difficultyIndex - b.difficultyIndex);
  }

  // ─────────────────────────────────────────────────────
  // 2. Dashboard completo de alertas (solo usuario actual)
  //    Útil para demostración / proyecto de un solo usuario
  // ─────────────────────────────────────────────────────

  async getMyAlertDashboard(): Promise<AlertDashboardData> {
    const uid = this.auth.currentUser?.uid;
    if (!uid) return this.emptyDashboard();

    const [exams, guides, stats] = await Promise.all([
      this.fetchExams(uid),
      this.fetchGuides(uid),
      this.fetchDailyStats(uid),
    ]);

    const alert = this.buildAlert(uid, 'Mi cuenta', '', exams, guides, stats);
    const difficulty = await this.getMyExamDifficulty();

    return this.buildDashboard([alert], difficulty, exams.length);
  }

  // ─────────────────────────────────────────────────────
  // 3. Dashboard multi-usuario (para admins / docentes)
  //    Consulta todos los documentos de exams/guides/stats
  //    y agrupa por uid.
  //    NOTA: requiere que las reglas de Firestore permitan
  //    leer documentos de otros usuarios o usar Cloud
  //    Functions para agregarlos.
  // ─────────────────────────────────────────────────────

  async getMultiUserAlertDashboard(uids: string[]): Promise<AlertDashboardData> {
    if (!uids.length) return this.emptyDashboard();

    // Firestore 'in' acepta máximo 30 valores en una consulta
    const chunks = this.chunkArray(uids, 10);
    const allAlerts: EarlyAlert[] = [];

    for (const chunk of chunks) {
      const [examsSnap, guidesSnap, statsSnap] = await Promise.all([
        getDocs(query(collection(this.firestore, 'exams'), where('uid', 'in', chunk))),
        getDocs(query(collection(this.firestore, 'studyGuides'), where('uid', 'in', chunk))),
        getDocs(query(collection(this.firestore, 'userDailyStats'), where('uid', 'in', chunk))),
      ]);

      // Agrupar por uid
      const examsByUid = this.groupBy(examsSnap.docs, d => String(d.data()['uid']));
      const guidesByUid = this.groupBy(guidesSnap.docs, d => String(d.data()['uid']));
      const statsByUid = this.groupBy(statsSnap.docs, d => String(d.data()['uid']));

      for (const uid of chunk) {
        const alert = this.buildAlert(
          uid,
          `Usuario ${uid.slice(0, 6)}`,
          '',
          examsByUid.get(uid) ?? [],
          guidesByUid.get(uid) ?? [],
          statsByUid.get(uid) ?? [],
        );
        allAlerts.push(alert);
      }
    }

    const difficulty = await this.getMyExamDifficulty();
    const totalExams = allAlerts.reduce((s, a) => s + a.detail.totalExamsCompleted, 0);
    return this.buildDashboard(allAlerts, difficulty, totalExams);
  }

  // ─────────────────────────────────────────────────────
  // Internos
  // ─────────────────────────────────────────────────────

  private buildAlert(
    uid: string,
    name: string,
    email: string,
    examDocs: any[],
    guideDocs: any[],
    statsDocs: any[],
  ): EarlyAlert {

    // Promedio de score en exámenes completados
    const completed = examDocs.filter(d => {
      const r = d.data?.()?.['results'] ?? d['results'];
      return r?.completed;
    });

    let avgExamScore = 0;
    if (completed.length > 0) {
      const sum = completed.reduce((acc, d) => {
        const r = d.data?.()?.['results'] ?? d['results'];
        const score = Number(r?.score ?? 0);
        const total = Number(r?.totalPoints ?? 1);
        return acc + (total > 0 ? score / total : 0);
      }, 0);
      avgExamScore = sum / completed.length;
    }

    // Días desde la última actividad
    const allDates: Date[] = [];
    for (const d of statsDocs) {
      const data = d.data?.() ?? d;
      const dateKey = String(data['dateKey'] ?? '');
      if (dateKey) allDates.push(this.fromDateKey(dateKey));
    }
    const lastActivity = allDates.length
      ? new Date(Math.max(...allDates.map(d => d.getTime())))
      : null;
    const daysSinceLastActivity = lastActivity
      ? Math.floor((Date.now() - lastActivity.getTime()) / 86400000)
      : 99;

    // Total de guías
    const totalGuides = guideDocs.length;

    // Minutos de estudio esta semana
    const now = new Date();
    const monday = this.getMonday(now);
    const weeklyStudyMinutes = statsDocs.reduce((acc, d) => {
      const data = d.data?.() ?? d;
      const dateKey = String(data['dateKey'] ?? '');
      const date = this.fromDateKey(dateKey);
      if (date >= monday) {
        return acc + Math.round((Number(data['studySeconds'] ?? 0)) / 60);
      }
      return acc;
    }, 0);

    // ── Cálculo del score de riesgo (0–100, mayor = más riesgo) ──

    // Factor 1: exámenes — si el promedio es bajo, el riesgo es alto
    const examFactor = completed.length === 0
      ? 1.0                                          // sin exámenes → riesgo máximo
      : Math.max(0, 1 - avgExamScore);              // score 0.3 → riesgo 0.7

    // Factor 2: inactividad — días sin actividad normalizado
    const inactivityFactor = Math.min(1, daysSinceLastActivity / INACTIVITY_MAX_DAYS);

    // Factor 3: guías — pocas guías → más riesgo
    const guidesFactor = Math.max(0, 1 - Math.min(totalGuides, GUIDES_TARGET) / GUIDES_TARGET);

    const riskScore = Math.round(
      (examFactor * RISK_WEIGHTS.examScore
        + inactivityFactor * RISK_WEIGHTS.inactivity
        + guidesFactor * RISK_WEIGHTS.guides) * 100
    );

    return {
      uid,
      displayName: name,
      email,
      riskScore,
      riskLevel: this.toRiskLevel(riskScore),
      detail: {
        avgExamScore,
        daysSinceLastActivity,
        totalGuides,
        totalExamsCompleted: completed.length,
        weeklyStudyMinutes,
      },
    };
  }

  private buildDashboard(
    alerts: EarlyAlert[],
    difficulty: ExamDifficultyResult[],
    totalExamsCompleted: number,
  ): AlertDashboardData {


    alerts.sort((a, b) => b.riskScore - a.riskScore);

    // taba de alerta
    const alertRows: DashboardAlertRow[] = alerts.slice(0, 20).map(a => ({
      student: a.displayName,
      career: '—',
      subject: a.detail.totalExamsCompleted > 0
        ? `${a.detail.totalExamsCompleted} exámen(es)`
        : 'Sin exámenes',
      risk: a.riskLevel,
      score: `${a.riskScore}%`,
    }));

    // KPIs
    const highRisk = alerts.filter(a => a.riskLevel === 'Alto').length;
    const avgActivity = alerts.length > 0
      ? Math.round(alerts.reduce((s, a) => s + (1 - a.detail.avgExamScore), 0) / alerts.length * 100)
      : 0;

    // Distribución de dificultad de exámenes
    const dist = { facil: 0, moderado: 0, dificil: 0 };
    for (const d of difficulty) {
      if (d.difficultyLabel === 'Fácil') dist.facil++;
      else if (d.difficultyLabel === 'Moderado') dist.moderado++;
      else dist.dificil++;
    }


    const recommendations = this.buildRecommendations(alerts, difficulty);

    return {
      alerts: alertRows,
      kpis: {
        totalStudents: alerts.length,
        highRiskCount: highRisk,
        activeSubjects: new Set(difficulty.map(d => d.topic)).size,
        avgActivityPercent: 100 - avgActivity,
      },
      difficultyDistribution: dist,
      recommendations,
    };
  }

 

  private buildRecommendations(
    alerts: EarlyAlert[],
    difficulty: ExamDifficultyResult[],
  ): string[] {
    const recs: string[] = [];

    const highRisk = alerts.filter(a => a.riskLevel === 'Alto');
    const inactive = alerts.filter(a => a.detail.daysSinceLastActivity > 7);
    const noGuides = alerts.filter(a => a.detail.totalGuides === 0);
    const hardExams = difficulty.filter(d => d.difficultyLabel === 'Difícil');

    if (highRisk.length > 0) {
      recs.push(
        `${highRisk.length} estudiante(s) tienen riesgo alto. Se recomienda contacto inmediato.`
      );
    }

    if (inactive.length > 0) {
      recs.push(
        `${inactive.length} usuario(s) llevan más de 7 días sin actividad registrada.`
      );
    }

    if (noGuides.length > 0) {
      recs.push(
        `${noGuides.length} estudiante(s) no han generado ninguna guía de estudio.`
      );
    }

    if (hardExams.length > 0) {
      const topics = [...new Set(hardExams.map(e => e.topic))].slice(0, 2).join(', ');
      recs.push(
        `Exámenes de "${topics}" presentan alta dificultad).`
      );
    }

    if (recs.length === 0) {
      recs.push('Sin alertas críticas por ahora.');
    }

    return recs;
  }



  private async fetchExams(uid: string) {
    const snap = await getDocs(
      query(collection(this.firestore, 'exams'), where('uid', '==', uid))
    );
    return snap.docs;
  }

  private async fetchGuides(uid: string) {
    const snap = await getDocs(
      query(collection(this.firestore, 'studyGuides'), where('uid', '==', uid))
    );
    return snap.docs;
  }

  private async fetchDailyStats(uid: string) {
    const snap = await getDocs(
      query(collection(this.firestore, 'userDailyStats'), where('uid', '==', uid))
    );
    return snap.docs;
  }

  private toDifficultyLabel(index: number): 'Fácil' | 'Moderado' | 'Difícil' {
    if (index >= 0.70) return 'Fácil';
    if (index >= 0.40) return 'Moderado';
    return 'Difícil';
  }

  private toRiskLevel(score: number): RiskLevel {
    if (score >= 65) return 'Alto';
    if (score >= 35) return 'Medio';
    return 'Bajo';
  }

  private fromDateKey(dateKey: string): Date {
    const [y, m, d] = dateKey.split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  private getMonday(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  private groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const item of items) {
      const k = key(item);
      const arr = map.get(k) ?? [];
      arr.push(item);
      map.set(k, arr);
    }
    return map;
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  private emptyDashboard(): AlertDashboardData {
    return {
      alerts: [],
      kpis: { totalStudents: 0, highRiskCount: 0, activeSubjects: 0, avgActivityPercent: 0 },
      difficultyDistribution: { facil: 0, moderado: 0, dificil: 0 },
      recommendations: ['No hay datos suficientes para generar recomendaciones.'],
    };
  }
}