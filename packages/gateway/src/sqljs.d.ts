declare module 'sql.js' {
  interface Database {
    exec(sql: string): any[];
    run(sql: string, params?: any[]): any;
    prepare(sql: string): Statement;
    export(): Uint8Array;
    close(): void;
  }
  
  interface Statement {
    run(params?: any[]): any;
    getAsObject(): any;
    step(): boolean;
    free(): void;
  }
  
  interface SqlJsStatic {
    (): Promise<SqlJsStatic>;
    Database: new (data?: Uint8Array) => Database;
  }
  
  const initSqlJs: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  export default initSqlJs;
}