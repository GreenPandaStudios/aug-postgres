#include "aug_postgres.h"
#include <libpq-fe.h>
#include <stdbool.h>
#include <stdio.h>
#include <arpa/inet.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <errno.h>
#include <pthread.h>
#include <poll.h>
#include <time.h>
#include <stdatomic.h>

/* A lease acquires its own native pool reference. The lent August wrapper and
   parameter buffers are never retained. Pool disposal closes idle sessions;
   existing leases retain their connection until released on the owner thread. */
struct State {pthread_t owner;char *configuration;int maximum,leases,references;int64_t connect_ms,cleanup_ms;bool closing;PGconn *idle[64];int idle_count;int64_t connect_seconds;};
struct Pool {struct State *state;};
struct Connection {struct State *pool;PGconn *connection;};
struct Cell {char *data;size_t size;Oid type;bool null;};
struct Result {pthread_t owner;struct Cell *cells;size_t rows,columns,capacity;int64_t changed;size_t bytes;};
static _Atomic int64_t live_pools,live_connections,live_results;
static int64_t clock_ms(void){struct timespec t;clock_gettime(CLOCK_MONOTONIC,&t);return (int64_t)t.tv_sec*1000+t.tv_nsec/1000000;}
static int32_t fail(aug_native_error_v1 *e,int32_t code,const char *message){if(e){e->code=code;size_t n=strlen(message);if(n>512)n=512;e->message_length=(uint32_t)n;memcpy(e->message,message,n);}return 1;}
static void clear(aug_native_error_v1 *e){if(e)memset(e,0,sizeof(*e));}
static bool owner(struct State *p){return p&&pthread_equal(p->owner,pthread_self());}
static int32_t state_code(const char *state){if(!state||strlen(state)!=5)return -2;int32_t code=0;for(int n=0;n<5;n++){int digit=state[n]>='0'&&state[n]<='9'?state[n]-'0':state[n]>='A'&&state[n]<='Z'?state[n]-'A'+10:-1;if(digit<0)return -2;code=code*36+digit;}return code+1;}
static bool text(const void *p,uint64_t n,size_t limit){return (!n||p)&&n<=limit&&(!n||!memchr(p,0,(size_t)n));}
static char *copy(const void *p,size_t n){char *s=malloc(n+1);if(s){if(n)memcpy(s,p,n);s[n]=0;}return s;}
static void quiet_notice(void *arg,const PGresult *result){(void)arg;(void)result;}
/* Cancellation is inspected on the native caller thread. Foreign threads never
   enter August. Every wait has an absolute deadline and checks at most 10 ms. */
static int wait_socket(int socket,short events,int64_t deadline,bool cancellable){
 for(;;){if(cancellable&&aug_native_cancelled_v1())return -5;int64_t left=deadline-clock_ms();if(left<=0)return -3;if(socket<0)return -2;
 struct pollfd fd={socket,events,0};int result=poll(&fd,1,(int)(left>10?10:left));if(result<0&&errno!=EINTR)return -2;if(result>0){if(fd.revents&(POLLERR|POLLHUP|POLLNVAL))return -2;return 0;}}
}
static void finish_connection(struct Connection *c){if(c->connection){PQfinish(c->connection);c->connection=NULL;atomic_fetch_sub(&live_connections,1);}}
static void cancel_and_discard(struct Connection *c){
 if(!c->connection)return;int64_t deadline=clock_ms()+c->pool->cleanup_ms;PGcancelConn *cancel=PQcancelCreate(c->connection);
 if(cancel){if(PQcancelStart(cancel)){PostgresPollingStatusType status;while((status=PQcancelPoll(cancel))!=PGRES_POLLING_OK&&status!=PGRES_POLLING_FAILED){if(wait_socket(PQcancelSocket(cancel),status==PGRES_POLLING_READING?POLLIN:POLLOUT,deadline,false))break;}}PQcancelFinish(cancel);}
 /* A cancellation dispatch cannot establish completion. This connection is
    discarded, so it can never return unread results or an open transaction. */
 finish_connection(c);
}
static int flush_query(PGconn *connection,int64_t deadline,bool cancellable){int flushing;while((flushing=PQflush(connection))==1){int status=wait_socket(PQsocket(connection),POLLOUT,deadline,cancellable);if(status)return status;}return flushing<0?-2:0;}
static int next_result(PGconn *connection,int64_t deadline,bool cancellable,PGresult **out){
 *out=NULL;if(cancellable&&aug_native_cancelled_v1())return -5;if(clock_ms()>=deadline)return -3;while(PQisBusy(connection)){int status=wait_socket(PQsocket(connection),POLLIN,deadline,cancellable);if(status)return status;if(!PQconsumeInput(connection))return -2;}
 *out=PQgetResult(connection);return 0;
}
AUG_EXPORT int32_t aug_postgres_pool_v1(const void *configuration,uint64_t size,int64_t maximum,int64_t connect_ms,int64_t cleanup_ms,void **out,aug_native_error_v1 *e){
 if(out)*out=NULL;clear(e);if(!out||!text(configuration,size,65536)||maximum<1||maximum>64||connect_ms<1||connect_ms>120000||cleanup_ms<1||cleanup_ms>30000)return fail(e,-1,"Invalid bounded pool configuration");
 struct State *p=calloc(1,sizeof(*p));if(!p)return fail(e,-9,"Allocation failed");p->configuration=copy(configuration,(size_t)size);if(!p->configuration){free(p);return fail(e,-9,"Allocation failed");}
 /* DNS resolution is synchronous in libpq. Require a numeric address, a Unix
    socket, or hostaddr so the connection deadline covers all network waiting. */
 char *parse_error=NULL;PQconninfoOption *options=PQconninfoParse(p->configuration,&parse_error);
 if(!options){if(parse_error)PQfreemem(parse_error);free(p->configuration);free(p);return fail(e,-1,"Invalid PostgreSQL connection configuration");}
 const char *host=NULL,*hostaddr=NULL;for(PQconninfoOption *o=options;o->keyword;o++){if(!strcmp(o->keyword,"host"))host=o->val;if(!strcmp(o->keyword,"hostaddr"))hostaddr=o->val;}
 unsigned char address[16];bool single=(!host||!strchr(host,','))&&(!hostaddr||!strchr(hostaddr,','));
 bool bounded=single&&hostaddr&&*hostaddr&&(inet_pton(AF_INET,hostaddr,address)==1||inet_pton(AF_INET6,hostaddr,address)==1);
 if(!hostaddr||!*hostaddr)bounded=single&&host&&*host&&(host[0]=='/'||inet_pton(AF_INET,host,address)==1||inet_pton(AF_INET6,host,address)==1);
 PQconninfoFree(options);if(!bounded){free(p->configuration);free(p);return fail(e,-1,"Use one numeric host, Unix socket, or numeric hostaddr to bound connection time");}
 p->connect_seconds=(connect_ms+999)/1000;
 p->owner=pthread_self();p->maximum=(int)maximum;p->connect_ms=connect_ms;p->cleanup_ms=cleanup_ms;p->references=1;struct Pool *wrapper=malloc(sizeof(*wrapper));if(!wrapper){free(p->configuration);free(p);return fail(e,-9,"Allocation failed");}wrapper->state=p;*out=wrapper;atomic_fetch_add(&live_pools,1);return 0;
}
AUG_EXPORT int32_t aug_postgres_acquire_v1(void *pool,void **out,aug_native_error_v1 *e){
 if(out)*out=NULL;clear(e);struct State *p=pool?((struct Pool *)pool)->state:NULL;if(!out||!owner(p))return fail(e,-6,"Pool must be used on its creating thread");if(aug_native_cancelled_v1())return fail(e,-5,"PostgreSQL acquisition was cancelled");if(p->closing||p->leases>=p->maximum)return fail(e,-4,"No pool lease is available");
 struct Connection *c=calloc(1,sizeof(*c));if(!c)return fail(e,-9,"Allocation failed");c->pool=p;
 if(p->idle_count)c->connection=p->idle[--p->idle_count];
 else{char seconds[24];snprintf(seconds,sizeof(seconds),"%lld",(long long)p->connect_seconds);
 const char *keywords[]={"dbname","client_encoding","connect_timeout",NULL};const char *values[]={p->configuration,"UTF8",seconds,NULL};
 c->connection=PQconnectStartParams(keywords,values,1);if(!c->connection){free(c);return fail(e,-2,"PostgreSQL connection failed");}atomic_fetch_add(&live_connections,1);
 int64_t deadline=clock_ms()+p->connect_ms;PostgresPollingStatusType status;int error=0;
 while((status=PQconnectPoll(c->connection))!=PGRES_POLLING_OK&&status!=PGRES_POLLING_FAILED){error=wait_socket(PQsocket(c->connection),status==PGRES_POLLING_READING?POLLIN:POLLOUT,deadline,true);if(error)break;}
 if(error||status==PGRES_POLLING_FAILED||PQsetnonblocking(c->connection,1)){finish_connection(c);free(c);return fail(e,error?error:-2,"PostgreSQL connection failed or reached its deadline");}PQsetNoticeReceiver(c->connection,quiet_notice,NULL);}
 p->leases++;p->references++;*out=c;return 0;
}
static void free_result(struct Result *r){if(!r)return;for(size_t i=0;i<r->rows*r->columns;i++)free(r->cells[i].data);free(r->cells);free(r);atomic_fetch_sub(&live_results,1);}
static int append_row(struct Result *r,PGresult *result,int64_t maximum_rows,int64_t maximum_bytes){
 size_t columns=(size_t)PQnfields(result);if(columns>256||r->rows>=(uint64_t)maximum_rows||(r->rows&&columns!=r->columns))return -7;
 size_t cost=columns*sizeof(struct Cell);for(size_t i=0;i<columns;i++){size_t n=(size_t)PQgetlength(result,0,(int)i);if(n>(uint64_t)maximum_bytes||cost>(uint64_t)maximum_bytes-n)return -7;cost+=n+1;}
 if(r->bytes>(uint64_t)maximum_bytes||cost>(uint64_t)maximum_bytes-r->bytes)return -7;
 r->columns=columns;size_t needed=(r->rows+1)*columns;if(needed>r->capacity){size_t capacity=needed;struct Cell *cells=realloc(r->cells,capacity*sizeof(*cells));if(!cells)return -9;r->cells=cells;r->capacity=capacity;}
 struct Cell *row=columns?r->cells+r->rows*columns:NULL;if(columns)memset(row,0,columns*sizeof(*row));r->rows++;
 for(size_t i=0;i<columns;i++){row[i].type=PQftype(result,(int)i);row[i].null=PQgetisnull(result,0,(int)i);row[i].size=(size_t)PQgetlength(result,0,(int)i);if(!row[i].null){row[i].data=copy(PQgetvalue(result,0,(int)i),row[i].size);if(!row[i].data)return -9;}}
 r->bytes+=cost;return 0;
}
AUG_EXPORT int32_t aug_postgres_query_v1(void *lease,const void *sql,uint64_t size,const void *const *parameters,const uint64_t *lengths,uint64_t count,int64_t timeout,int64_t maximum_rows,int64_t maximum_bytes,void **out,aug_native_error_v1 *e){
 if(out)*out=NULL;clear(e);struct Connection *c=lease;if(!out||!c||!owner(c->pool))return fail(e,-6,"Connection must be used on its creating thread");
 if(!c->connection)return fail(e,-2,"Connection was discarded; acquire a new lease");
 if(!text(sql,size,1048576)||!size||count>4096||(count&&(!parameters||!lengths))||timeout<1||timeout>120000||maximum_rows<1||maximum_rows>100000||maximum_bytes<1||maximum_bytes>67108864)return fail(e,-1,"Invalid bounded query input");
 int64_t deadline=clock_ms()+timeout;
 char *statement=copy(sql,(size_t)size);char **values=calloc(count?count:1,sizeof(*values));if(!statement||!values){free(statement);free(values);return fail(e,-9,"Allocation failed");}
 int failure=0;size_t total=0;for(uint64_t i=0;i<count;i++){if(!text(parameters[i],lengths[i],16777216)||lengths[i]>67108864-total){failure=-1;break;}total+=(size_t)lengths[i];values[i]=copy(parameters[i],(size_t)lengths[i]);if(!values[i]){failure=-9;break;}}
 if(!failure&&aug_native_cancelled_v1())failure=-5;
 if(!failure&&clock_ms()>=deadline)failure=-3;
 if(!failure&&!PQsendQueryParams(c->connection,statement,(int)count,NULL,(const char *const *)values,NULL,NULL,0))failure=-2;
 free(statement);for(uint64_t i=0;i<count;i++)free(values[i]);free(values);if(failure)return fail(e,failure,"PostgreSQL query could not start");
 if(!PQsetSingleRowMode(c->connection)){cancel_and_discard(c);return fail(e,-2,"PostgreSQL row streaming failed");}
 failure=flush_query(c->connection,deadline,true);struct Result *r=calloc(1,sizeof(*r));if(r){r->owner=pthread_self();atomic_fetch_add(&live_results,1);}else failure=-9;
 while(!failure){PGresult *result=NULL;failure=next_result(c->connection,deadline,true,&result);if(failure)break;if(!result)break;ExecStatusType status=PQresultStatus(result);
 if(status==PGRES_SINGLE_TUPLE)failure=append_row(r,result,maximum_rows,maximum_bytes);
 else if(status==PGRES_TUPLES_OK){if(PQnfields(result)>256)failure=-7;else if(!r->rows)r->columns=(size_t)PQnfields(result);}
 else if(status==PGRES_COMMAND_OK){const char *changed=PQcmdTuples(result);if(*changed){errno=0;char *end;long long n=strtoll(changed,&end,10);if(errno||*end||n<0)failure=-7;else r->changed=n;}}
 else if(status==PGRES_FATAL_ERROR||status==PGRES_NONFATAL_ERROR){int32_t code=state_code(PQresultErrorField(result,PG_DIAG_SQLSTATE));fail(e,code,"PostgreSQL rejected the statement");failure=code;}
 else failure=-2;PQclear(result);}
 if(failure){/* Read remaining results after a server error, or discard on any
                deadline, cancellation, unsupported result, or resource bound. */
   if(failure>0){PGresult *result=NULL;int status;while(!(status=next_result(c->connection,deadline,true,&result))&&result)PQclear(result);if(status)cancel_and_discard(c);}
   else cancel_and_discard(c);free_result(r);if(e&&e->code)return 1;return fail(e,failure,"PostgreSQL query failed, exceeded a limit, or was cancelled");}
 *out=r;return 0;
}
static struct Cell *cell(const struct Result *r,int64_t row,int64_t column,aug_native_error_v1 *e){if(!r||!pthread_equal(r->owner,pthread_self())){fail(e,-6,"Result must be used on its creating thread");return NULL;}if(row<0||column<0||(uint64_t)row>=r->rows||(uint64_t)column>=r->columns){fail(e,-1,"Result index is out of bounds");return NULL;}return &r->cells[(size_t)row*r->columns+(size_t)column];}
AUG_EXPORT int32_t aug_postgres_rows_v1(const void *result,int64_t *out,aug_native_error_v1 *e){clear(e);const struct Result *r=result;if(!out||!r||!pthread_equal(r->owner,pthread_self()))return fail(e,-6,"Result must be used on its creating thread");*out=(int64_t)r->rows;return 0;}
AUG_EXPORT int32_t aug_postgres_null_v1(const void *result,int64_t row,int64_t column,uint8_t *out,aug_native_error_v1 *e){clear(e);if(out)*out=0;struct Cell *value=cell(result,row,column,e);if(!out||!value)return 1;*out=value->null;return 0;}
AUG_EXPORT int32_t aug_postgres_text_v1(const void *result,int64_t row,int64_t column,void **out,uint64_t *size,aug_native_error_v1 *e){clear(e);if(out)*out=NULL;if(size)*size=0;struct Cell *value=cell(result,row,column,e);if(!out||!size||!value)return 1;if(value->null)return fail(e,-8,"A null column has no text value");*out=copy(value->data,value->size);if(!*out)return fail(e,-9,"Allocation failed");*size=value->size;return 0;}
AUG_EXPORT int32_t aug_postgres_bytes_v1(const void *result,int64_t row,int64_t column,void **out,uint64_t *size,aug_native_error_v1 *e){clear(e);if(out)*out=NULL;if(size)*size=0;struct Cell *value=cell(result,row,column,e);if(!out||!size||!value)return 1;if(value->null||value->type!=17)return fail(e,-8,"Expected a non-null bytea column");size_t count;unsigned char *decoded=PQunescapeBytea((unsigned char *)value->data,&count);if(!decoded)return fail(e,-2,"PostgreSQL bytea decoding failed");*out=malloc(count?count:1);if(!*out){PQfreemem(decoded);return fail(e,-9,"Allocation failed");}memcpy(*out,decoded,count);*size=count;PQfreemem(decoded);return 0;}
AUG_EXPORT void aug_postgres_buffer_release_v1(void *data){free(data);}
AUG_EXPORT void aug_postgres_result_release_v1(void *result){struct Result *r=result;if(r&&!pthread_equal(r->owner,pthread_self()))abort();free_result(r);}
static void unref_pool(struct State *p){if(--p->references)return;size_t size=strlen(p->configuration);volatile unsigned char *bytes=(volatile unsigned char *)p->configuration;while(size--)bytes[size]=0;free(p->configuration);free(p);atomic_fetch_sub(&live_pools,1);}
AUG_EXPORT void aug_postgres_pool_release_v1(void *pool){struct State *p=pool?((struct Pool *)pool)->state:NULL;if(!p)return;if(!owner(p))abort();p->closing=true;while(p->idle_count){PQfinish(p->idle[--p->idle_count]);atomic_fetch_sub(&live_connections,1);}free(pool);unref_pool(p);}
AUG_EXPORT void aug_postgres_connection_release_v1(void *lease){struct Connection *c=lease;if(!c)return;struct State *p=c->pool;if(!owner(p))abort();
 if(c->connection&&PQtransactionStatus(c->connection)!=PQTRANS_IDLE){int64_t deadline=clock_ms()+p->cleanup_ms;bool clean=PQsendQueryParams(c->connection,"ROLLBACK",0,NULL,NULL,NULL,NULL,0)&&!flush_query(c->connection,deadline,false);PGresult *result=NULL;while(clean){int status=next_result(c->connection,deadline,false,&result);if(status){clean=false;break;}if(!result)break;if(PQresultStatus(result)!=PGRES_COMMAND_OK)clean=false;PQclear(result);}if(!clean||PQtransactionStatus(c->connection)!=PQTRANS_IDLE)finish_connection(c);}
 if(c->connection){if(p->closing||PQstatus(c->connection)!=CONNECTION_OK)finish_connection(c);else{p->idle[p->idle_count++]=c->connection;c->connection=NULL;}}
 p->leases--;free(c);unref_pool(p);
}
AUG_EXPORT int64_t aug_postgres_live_pools_v1(void){return atomic_load(&live_pools);}
AUG_EXPORT int64_t aug_postgres_live_connections_v1(void){return atomic_load(&live_connections);}
AUG_EXPORT int64_t aug_postgres_live_results_v1(void){return atomic_load(&live_results);}
