#include "aug_postgres.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <time.h>
#include <pthread.h>
static _Atomic bool cancelled;
static unsigned probes,cancel_after;
uint8_t aug_native_cancelled_v1(void) { return atomic_load(&cancelled)||(cancel_after&&++probes>=cancel_after); }
static int64_t milliseconds(void) { struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000; }
static void *cancel_later(void *unused) { (void)unused;struct timespec wait={0,30000000};nanosleep(&wait,NULL);atomic_store(&cancelled,true);return NULL; }
static void *statement(void *connection,const char *sql,const char *parameter,int64_t timeout,int64_t maximum_rows,int32_t expected) {
 void *result=NULL;aug_native_error_v1 error={0};const void *parameters[]={parameter};uint64_t sizes[]={parameter?strlen(parameter):0};
 int32_t status=aug_postgres_query_v1(connection,sql,strlen(sql),parameters,sizes,parameter?1:0,timeout,maximum_rows,1048576,&result,&error);
 if((status!=0)!=(expected!=0)||(expected&&error.code!=expected)){fprintf(stderr,"Unexpected query status %d code %d\n",status,error.code);abort();}
 return result;
}
static void check_text(void *result,int64_t row,const char *expected) { void *value=NULL;uint64_t length;aug_native_error_v1 error;assert(!aug_postgres_text_v1(result,row,0,&value,&length,&error));assert(length==strlen(expected)&&!memcmp(value,expected,length));aug_postgres_buffer_release_v1(value); }
static void *wrong_thread(void *result) { int64_t rows;aug_native_error_v1 error;assert(aug_postgres_rows_v1(result,&rows,&error)&&error.code==-6);return NULL; }
int main(int argc,char **argv) {
 assert(argc==2||argc==3);char configuration[512];assert(strlen(argv[1]) < sizeof(configuration));snprintf(configuration,sizeof(configuration),"%s",argv[1]);
 void *pool=NULL,*connection=NULL,*other=NULL;aug_native_error_v1 error;
 const char *invalid[]={"host=/tmp/no-socket,slow.dns.example", "host=127.0.0.1,slow.dns.example hostaddr=127.0.0.1,", "host=localhost hostaddr=not-an-address"};
 for(size_t i=0;i<sizeof(invalid)/sizeof(*invalid);i++)assert(aug_postgres_pool_v1(invalid[i],strlen(invalid[i]),1,100,100,&pool,&error)&&error.code==-1&&!pool);
 assert(!aug_postgres_pool_v1(configuration,strlen(configuration),1,2000,100,&pool,&error));
 if(argc==3&&!strcmp(argv[2],"observe-query")){
   assert(!aug_postgres_acquire_v1(pool,&connection,&error));void *result=statement(connection,"SELECT count(*) FROM pg_stat_activity WHERE application_name='aug-qualification-http' AND state='active' AND query='SELECT pg_sleep(5)'",NULL,1000,1,0);
   void *value=NULL;uint64_t length=0;assert(!aug_postgres_text_v1(result,0,0,&value,&length,&error));bool active=length==1&&((char *)value)[0]=='1';aug_postgres_buffer_release_v1(value);aug_postgres_result_release_v1(result);aug_postgres_connection_release_v1(connection);aug_postgres_pool_release_v1(pool);
   assert(!aug_postgres_live_pools_v1()&&!aug_postgres_live_connections_v1()&&!aug_postgres_live_results_v1());return active?0:2;
 }
 if(argc==3){assert(!strcmp(argv[2],"reject-connect"));assert(aug_postgres_acquire_v1(pool,&connection,&error)&&!connection);aug_postgres_pool_release_v1(pool);assert(!aug_postgres_live_pools_v1()&&!aug_postgres_live_connections_v1());puts("Untrusted TLS connection rejected without leaks");return 0;}
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));assert(aug_postgres_acquire_v1(pool,&other,&error)&&error.code==-4&&!other);
 void *result=statement(connection,"SHOW server_version",NULL,1000,10,0);check_text(result,0,"18.6");aug_postgres_result_release_v1(result);
 result=statement(connection,"CREATE TEMP TABLE items (id int PRIMARY KEY, body bytea)",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"BEGIN",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"INSERT INTO items VALUES (1, $1::bytea)","\\x00017fff80",1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"SAVEPOINT row_attempt",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 int32_t duplicate=1;const char *state="23505";for(int i=0;i<5;i++)duplicate=(duplicate-1)*36+(state[i]-'0')+1;
 assert(!statement(connection,"INSERT INTO items VALUES (1, NULL)",NULL,1000,10,duplicate));
 result=statement(connection,"ROLLBACK TO SAVEPOINT row_attempt",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"SELECT pg_advisory_xact_lock(7)",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"COMMIT",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"SELECT body, NULL::text FROM items WHERE id = $1::int","1",1000,10,0);
 int64_t count=0;uint8_t null=0;assert(!aug_postgres_rows_v1(result,&count,&error)&&count==1);assert(!aug_postgres_null_v1(result,0,1,&null,&error)&&null);
 void *bytes=NULL;uint64_t size;unsigned char expected[]={0,1,127,255,128};assert(!aug_postgres_bytes_v1(result,0,0,&bytes,&size,&error)&&size==sizeof(expected)&&!memcmp(bytes,expected,size));aug_postgres_buffer_release_v1(bytes);
 pthread_t thread;assert(!pthread_create(&thread,NULL,wrong_thread,result));pthread_join(thread,NULL);aug_postgres_result_release_v1(result);
 result=statement(connection,"BEGIN",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 result=statement(connection,"INSERT INTO items VALUES (2, NULL)",NULL,1000,10,0);aug_postgres_result_release_v1(result);
 aug_postgres_connection_release_v1(connection);assert(!aug_postgres_acquire_v1(pool,&connection,&error));
 result=statement(connection,"SELECT count(*) FROM items",NULL,1000,10,0);check_text(result,0,"1");aug_postgres_result_release_v1(result);
 int64_t started=milliseconds();assert(!statement(connection,"SELECT pg_sleep(5)",NULL,50,10,-3));assert(milliseconds()-started<700);aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));assert(!pthread_create(&thread,NULL,cancel_later,NULL));started=milliseconds();assert(!statement(connection,"SELECT pg_sleep(5)",NULL,1000,10,-5));pthread_join(thread,NULL);assert(milliseconds()-started<700);atomic_store(&cancelled,false);aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));assert(!statement(connection,"SELECT generate_series(1,10)",NULL,1000,4,-7));aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));
 char columns[8192]="SELECT ";for(int i=0;i<257;i++)strcat(columns,i?",NULL":"NULL");strcat(columns," WHERE false");
 assert(!statement(connection,columns,NULL,1000,10,-7));aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));cancel_after=100;probes=0;
 assert(!statement(connection,"SELECT generate_series(1,10000)",NULL,1000,20000,-5));cancel_after=0;aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_acquire_v1(pool,&connection,&error));aug_postgres_pool_release_v1(pool);
 result=statement(connection,"SELECT $1::text","Unicode: 🦆",1000,10,0);check_text(result,0,"Unicode: 🦆");aug_postgres_result_release_v1(result);aug_postgres_connection_release_v1(connection);
 assert(!aug_postgres_live_pools_v1()&&!aug_postgres_live_connections_v1()&&!aug_postgres_live_results_v1());puts("PostgreSQL transaction, bytea, SQLSTATE, bounds, deadline, cancellation and cleanup passed");return 0;
}
